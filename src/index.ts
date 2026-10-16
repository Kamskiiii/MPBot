import './load-env.js';
/** До discord.js: патчит WebSocket при DISCORD_PROXY. */
import { getDiscordProxyRestAgent } from './proxy-setup.js';
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';
import { applyDiscordRoleSync } from './apply-discord-role-sync.js';
import { createApiClient, ApiError } from './api.js';
import { loadStaticEnv, type VpBotConfigFromApi } from './config.js';
import { startPanelSyncPoller } from './panel-sync.js';
import { startChannelCatalogPoller } from './channel-catalog-poller.js';
import { startChannelMessagePoller } from './channel-message-poller.js';
import { startLeaveNotifyPoller } from './leave-notify-poller.js';
import { startFormDiscordThreadPoller } from './form-discord-thread-poller.js';
import { startInvestigatorChoicesPoller } from './investigator-choices-poller.js';
import {
  CANDIDATE_APPLICATION_MODAL_ID,
  CANDIDATE_APPROVE_BUTTON_PREFIX,
  CANDIDATE_APPROVE_SELECT_PREFIX,
  CANDIDATE_REJECT_BUTTON_PREFIX,
  CANDIDATE_REJECT_MODAL_PREFIX,
  dmApplicantAboutNewThreadMessage,
  findCandidateRequestIdByThread,
  handleCandidateApplicationModalSubmit,
  handleCandidateApproveButton,
  handleCandidateApproveSelect,
  handleCandidateRejectButton,
  handleCandidateRejectModalSubmit,
  handleWelcomeCandidateButton,
  isCandidateApplicationContext,
} from './candidate-application.js';
import {
  canModerateLeaveRequest,
  findLeaveRequestIdByThread,
  handleLeaveApplicationModalSubmit,
  handleLeaveRejectButton,
  handleLeaveRejectModalSubmit,
  handleWelcomeLeaveButton,
  isLeaveRequestContext,
  LEAVE_APPLICATION_MODAL_ID,
  LEAVE_REJECT_BUTTON_PREFIX,
  LEAVE_REJECT_MODAL_PREFIX,
  postLeaveNotifyMessage,
  purgeLeaveRequestThread,
  ACTIONS_LEAVE_BUTTON_ID,
} from './leave-request.js';
import {
  canModerateRoleRequest,
  findRoleRequestIdByThread,
  handleRoleRequestRejectButton,
  handleRoleRequestRejectModalSubmit,
  handleRoleRequestSelect,
  handleRoleRequestSubmit,
  handleWelcomeRoleRequestButton,
  isRoleRequestContext,
  purgeRoleRequestThread,
  ROLE_REQUEST_OTHER_SELECT_PREFIX,
  ROLE_REQUEST_POSITION_SELECT_PREFIX,
  ROLE_REQUEST_REJECT_BUTTON_PREFIX,
  ROLE_REQUEST_REJECT_MODAL_PREFIX,
  ROLE_REQUEST_SUBMIT_PREFIX,
  ACTIONS_ROLE_REQUEST_BUTTON_ID,
} from './role-request.js';
import {
  handleWelcomeGuestButton,
  handleWelcomeGuestModalSubmit,
  VP_GUEST_APPLICATION_MODAL_ID,
  WELCOME_CANDIDATE_BUTTON_ID,
  WELCOME_GUEST_BUTTON_ID,
} from './welcome-panel.js';
import {
  handleWantedAddButton,
  handleWantedAddModalSubmit,
  handleWantedClassSelect,
  handleWantedRemoveButton,
  handleWantedRemovePageButton,
  handleWantedRemoveSelect,
  WANTED_ADD_BUTTON_ID,
  WANTED_ADD_MODAL_ID,
  WANTED_CLASS_SELECT_ID,
  WANTED_REMOVE_BUTTON_ID,
  WANTED_REMOVE_PAGE_PREFIX,
  WANTED_REMOVE_SELECT_PREFIX,
} from './wanted-panel.js';
import {
  TRAINING_REQUEST_BUTTON_ID,
  handleTrainingRequestButton,
  syncTrainingPanel,
} from './training-request.js';
import { startWantedAlertPoller } from './wanted-alert-poller.js';
import { startWantedDossierPoller } from './wanted-dossier-poller.js';

function errorCode(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  const ne = e as NodeJS.ErrnoException | undefined;
  if (ne?.code && typeof ne.code === 'string') return ne.code;
  return undefined;
}

function isRetryableDiscordConnectError(e: unknown): boolean {
  if (errorCode(e) === 'TokenInvalid') return false;
  const codes = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ]);
  const c = errorCode(e);
  return c ? codes.has(c) : false;
}

async function loginWithRetries(client: Client, token: string): Promise<void> {
  const attempts = 5;
  const delaysMs = [2000, 4000, 8000, 12000, 20000];
  for (let i = 0; i < attempts; i++) {
    try {
      await client.login(token);
      return;
    } catch (e) {
      if (!isRetryableDiscordConnectError(e) || i === attempts - 1) {
        throw e;
      }
      const ms = delaysMs[i] ?? 20000;
      console.warn(
        `Сеть до Discord оборвалась (${errorCode(e) ?? 'unknown'}), следующая попытка через ${ms / 1000} с (${i + 2}/${attempts})`,
      );
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}

const staticEnv = loadStaticEnv();
const apiForUrl = (base: string) => createApiClient(base, staticEnv.secret);

let cachedConfig: { at: number; cfg: VpBotConfigFromApi } | null = null;
const CONFIG_TTL_MS = 15_000;

async function getConfig(): Promise<VpBotConfigFromApi> {
  const now = Date.now();
  if (cachedConfig && now - cachedConfig.at < CONFIG_TTL_MS) {
    return cachedConfig.cfg;
  }
  const cfg = await apiForUrl(staticEnv.backendFallback).getBotConfig();
  cachedConfig = { at: now, cfg };
  return cfg;
}

/** Guilds + GuildMessages + reactions + members. MessageContent — опционально. */
const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
];
if (staticEnv.messageContentIntent) {
  intents.push(GatewayIntentBits.MessageContent);
}

const discordProxyAgent = getDiscordProxyRestAgent();
const client = new Client({
  intents,
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  ...(discordProxyAgent ? { rest: { agent: discordProxyAgent } } : {}),
});

// Описываем слеш-команду
const setupTrainingCommand = new SlashCommandBuilder()
  .setName('setup-training')
  .setDescription('Опубликовать или обновить панель запроса обучения в канале');

const ADMIN_DISCORD_ID = '683936697431490581';
const GUILD_ID = '1267079204571185214'; // ID вашего сервера

client.once('clientReady', async () => {
  console.log(`Агент ВП авторизован: ${client.user?.tag}`);

  // Регистрация команды на сервере при старте
  try {
    const rest = new REST({ version: '10' }).setToken(staticEnv.token);
    await rest.put(
      Routes.applicationGuildCommands(client.user!.id, GUILD_ID),
      { body: [setupTrainingCommand.toJSON()] },
    );
    console.log('Слеш-команда /setup-training успешно зарегистрирована на сервере!');
  } catch (err) {
    console.error('Не удалось зарегистрировать слеш-команду:', err);
  }

  // Синхронизация панели обучения при запуске бота
  try {
    const config = await getConfig();
    const api = apiForUrl(staticEnv.backendFallback);
    await syncTrainingPanel(client, config, api);
    console.log('Панель запроса обучения успешно синхронизирована!');
  } catch (err) {
    console.error('Ошибка при автоматической синхронизации панели обучения:', err);
  }

  if (!staticEnv.messageContentIntent) {
    console.warn(
      'VP_MESSAGE_CONTENT_INTENT не включён: бот стартует без privileged Message Content.',
    );
  }

  startPanelSyncPoller(client, staticEnv.backendFallback, apiForUrl).start();
  startChannelCatalogPoller(client, staticEnv.backendFallback, apiForUrl).start();
  startChannelMessagePoller(client, staticEnv.backendFallback, apiForUrl).start();
  startLeaveNotifyPoller(client, staticEnv.backendFallback, apiForUrl).start();
  startFormDiscordThreadPoller(client, staticEnv.backendFallback, apiForUrl).start();
  startInvestigatorChoicesPoller(client, staticEnv.backendFallback, apiForUrl).start();
  startWantedAlertPoller(client, staticEnv.backendFallback, apiForUrl).start();
  startWantedDossierPoller(client, staticEnv.backendFallback, apiForUrl).start();
});

// Обработчик взаимодействий (команды и кнопки)
client.on('interactionCreate', async (interaction) => {
  try {
    // Обработка нажатий на кнопки
    if (interaction.isButton()) {
      if (interaction.customId === TRAINING_REQUEST_BUTTON_ID) {
        const config = await getConfig();
        await handleTrainingRequestButton(interaction, config);
        return;
      }
      return;
    }

    // Обработка слеш-команд
    if (interaction.isChatInputCommand()) {
      if (interaction.user.id !== ADMIN_DISCORD_ID) {
        await interaction.reply({ 
          content: 'У вас нет прав на использование этой команды.', 
          flags: MessageFlags.Ephemeral 
        });
        return;
      }

      if (interaction.commandName === 'setup-training') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const config = await getConfig();
          const api = apiForUrl(staticEnv.backendFallback);
          await syncTrainingPanel(client, config, api);
          await interaction.editReply({ content: 'Панель запроса обучения успешно опубликована/обновлена!' });
        } catch (e) {
          console.error('Ошибка выполнения /setup-training:', e);
          await interaction.editReply({ content: 'Произошла ошибка при публикации панели обучения.' });
        }
        return;
      }
    }
  } catch (err) {
    console.error('Ошибка в обработчике interactionCreate:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Произошла непредвиденная ошибка.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

loginWithRetries(client, staticEnv.token).catch((err) => {
  console.error('Не удалось авторизоваться в Discord:', err);
  process.exit(1);
});