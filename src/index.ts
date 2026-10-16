import './load-env.js';
/** До discord.js: патчит WebSocket при DISCORD_PROXY. */
import { getDiscordProxyRestAgent } from './proxy-setup.js';
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';
import { applyDiscordRoleSync } from './apply-discord-role-sync.js';
import { createApiClient, ApiError } from './api.js';
import { loadFileConfig, loadStaticEnv, type BotConfig } from './config.js';
import { openStore } from './store.js';
import { createVdvClient } from './vdv.js';
import { startPanelSyncPoller } from './panel-sync.js';
import { startChannelCatalogPoller } from './channel-catalog-poller.js';
import { startChannelMessagePoller } from './channel-message-poller.js';
import { startLeaveNotifyPoller } from './leave-notify-poller.js';
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
const store = openStore(`${staticEnv.dataDir}/bot.sqlite`);
const api = createApiClient({
  store,
  file: loadFileConfig(staticEnv.configPath),
  vdv: staticEnv.vdv
    ? createVdvClient(staticEnv.vdv.url, staticEnv.vdv.secret)
    : null,
});
/** Pollers принимают фабрику api; клиент один, URL не нужен. */
const apiForUrl = () => api;

let cachedConfig: { at: number; cfg: BotConfig } | null = null;
const CONFIG_TTL_MS = 15_000;

async function getConfig(): Promise<BotConfig> {
  const now = Date.now();
  if (cachedConfig && now - cachedConfig.at < CONFIG_TTL_MS) {
    return cachedConfig.cfg;
  }
  const cfg = await api.getBotConfig();
  cachedConfig = { at: now, cfg };
  return cfg;
}

function isApproveEmoji(name: string | null): boolean {
  return name === '✅' || name === '✔️' || name === '☑';
}

async function removeBotPendingReaction(
  message: Message,
  botId: string,
): Promise<void> {
  const pending = message.reactions.cache.find(
    (r) => r.emoji.name === '⏳' && r.me,
  );
  if (!pending) return;
  try {
    await pending.users.remove(botId);
  } catch {
    /* ignore */
  }
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

const SETUP_PANELS_COMMAND = 'setup-panels';
const SETUP_TRAINING_COMMAND = 'setup-training';
const slashCommands = [
  new SlashCommandBuilder()
    .setName(SETUP_PANELS_COMMAND)
    .setDescription('Опубликовать или обновить панели (приветствие, действия)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName(SETUP_TRAINING_COMMAND)
    .setDescription('Опубликовать или обновить панель запроса обучения')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

client.once('clientReady', async () => {
  console.log(`Агент ВП авторизован: ${client.user?.tag}`);
  if (!staticEnv.messageContentIntent) {
    console.warn('VP_MESSAGE_CONTENT_INTENT не включён: бот стартует без privileged Message Content.');
  }

  const cfg = await getConfig();
  if (cfg.guildId) {
    try {
      await new REST({ version: '10' })
        .setToken(staticEnv.token)
        .put(Routes.applicationGuildCommands(client.user!.id, cfg.guildId), {
          body: slashCommands,
        });
    } catch (err) {
      console.error('Не удалось зарегистрировать слеш-команды:', err);
    }
  } else {
    console.warn('guildId не задан в config.json: слеш-команды не зарегистрированы.');
  }

  // Панели публикуются/обновляются при каждом старте (и по /setup-panels).
  api.requestPanelSync();
  try {
    await syncTrainingPanel(client, cfg, api);
  } catch (err) {
    console.error('Ошибка синхронизации панели обучения:', err);
  }

  startPanelSyncPoller(client, '', apiForUrl).start();
  startLeaveNotifyPoller(client, '', apiForUrl).start();
  if (staticEnv.vdv) {
    startChannelCatalogPoller(client, '', apiForUrl).start();
    startChannelMessagePoller(client, '', apiForUrl).start();
    startWantedAlertPoller(client, '', apiForUrl).start();
    startWantedDossierPoller(client, '', apiForUrl).start();
    console.log('Интеграция VDV включена.');
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cfg = await getConfig();
      const allowed =
        cfg.adminDiscordUserIds.includes(interaction.user.id) ||
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
      if (!allowed) {
        await interaction.reply({
          content: 'У вас нет прав на использование этой команды.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (interaction.commandName === SETUP_PANELS_COMMAND) {
        api.requestPanelSync();
        await interaction.reply({
          content: 'Панели будут обновлены в течение ~30 секунд.',
          flags: MessageFlags.Ephemeral,
        });
      } else if (interaction.commandName === SETUP_TRAINING_COMMAND) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await syncTrainingPanel(client, cfg, api);
          await interaction.editReply('Панель запроса обучения опубликована/обновлена.');
        } catch (e) {
          console.error('/setup-training:', e);
          await interaction.editReply('Не удалось опубликовать панель обучения.');
        }
      }
      return;
    }
    if (interaction.isButton()) {
      const cfg = await getConfig();
      if (interaction.customId === TRAINING_REQUEST_BUTTON_ID) {
        await handleTrainingRequestButton(interaction, cfg);
        return;
      }
      if (interaction.customId === WELCOME_GUEST_BUTTON_ID) {
        await handleWelcomeGuestButton(interaction, cfg);
        return;
      }
      if (interaction.customId === WELCOME_CANDIDATE_BUTTON_ID) {
        await handleWelcomeCandidateButton(interaction, cfg);
        return;
      }
      if (
        interaction.customId === ACTIONS_ROLE_REQUEST_BUTTON_ID ||
        interaction.customId === 'vp_welcome_role_request'
      ) {
        await handleWelcomeRoleRequestButton(interaction, cfg);
        return;
      }
      if (
        interaction.customId === ACTIONS_LEAVE_BUTTON_ID ||
        interaction.customId === 'vp_welcome_leave_request'
      ) {
        await handleWelcomeLeaveButton(interaction, cfg);
        return;
      }
      if (interaction.customId.startsWith(ROLE_REQUEST_SUBMIT_PREFIX)) {
        await handleRoleRequestSubmit(interaction, cfg, api);
        return;
      }
      if (interaction.customId.startsWith(CANDIDATE_APPROVE_BUTTON_PREFIX)) {
        await handleCandidateApproveButton(interaction, cfg);
        return;
      }
      if (interaction.customId.startsWith(CANDIDATE_REJECT_BUTTON_PREFIX)) {
        await handleCandidateRejectButton(interaction, cfg);
        return;
      }
      if (interaction.customId.startsWith(ROLE_REQUEST_REJECT_BUTTON_PREFIX)) {
        await handleRoleRequestRejectButton(interaction, cfg);
        return;
      }
      if (interaction.customId.startsWith(LEAVE_REJECT_BUTTON_PREFIX)) {
        await handleLeaveRejectButton(interaction, cfg);
        return;
      }
      if (interaction.customId === WANTED_ADD_BUTTON_ID) {
        await handleWantedAddButton(interaction, cfg);
        return;
      }
      if (interaction.customId === WANTED_REMOVE_BUTTON_ID) {
        await handleWantedRemoveButton(interaction, cfg, api);
        return;
      }
      if (interaction.customId.startsWith(WANTED_REMOVE_PAGE_PREFIX)) {
        await handleWantedRemovePageButton(interaction, cfg, api);
        return;
      }
      return;
    }
    if (interaction.isStringSelectMenu()) {
      const cfg = await getConfig();
      if (interaction.customId.startsWith(CANDIDATE_APPROVE_SELECT_PREFIX)) {
        await handleCandidateApproveSelect(interaction, cfg, api);
        return;
      }
      if (
        interaction.customId.startsWith(ROLE_REQUEST_POSITION_SELECT_PREFIX) ||
        interaction.customId.startsWith(ROLE_REQUEST_OTHER_SELECT_PREFIX)
      ) {
        await handleRoleRequestSelect(interaction);
        return;
      }
      if (interaction.customId === WANTED_CLASS_SELECT_ID) {
        await handleWantedClassSelect(interaction, cfg, api);
        return;
      }
      if (interaction.customId.startsWith(WANTED_REMOVE_SELECT_PREFIX)) {
        await handleWantedRemoveSelect(interaction, cfg, api);
        return;
      }
      return;
    }
    if (interaction.isModalSubmit()) {
      const cfg = await getConfig();
      if (interaction.customId === VP_GUEST_APPLICATION_MODAL_ID) {
        await handleWelcomeGuestModalSubmit(interaction, cfg);
        return;
      }
      if (interaction.customId === CANDIDATE_APPLICATION_MODAL_ID) {
        await handleCandidateApplicationModalSubmit(interaction, cfg, api);
        return;
      }
      if (interaction.customId === LEAVE_APPLICATION_MODAL_ID) {
        await handleLeaveApplicationModalSubmit(interaction, cfg, api);
        return;
      }
      if (interaction.customId.startsWith(CANDIDATE_REJECT_MODAL_PREFIX)) {
        await handleCandidateRejectModalSubmit(interaction, cfg, api);
        return;
      }
      if (interaction.customId.startsWith(ROLE_REQUEST_REJECT_MODAL_PREFIX)) {
        await handleRoleRequestRejectModalSubmit(interaction, cfg, api);
        return;
      }
      if (interaction.customId.startsWith(LEAVE_REJECT_MODAL_PREFIX)) {
        await handleLeaveRejectModalSubmit(interaction, cfg, api);
        return;
      }
      if (interaction.customId === WANTED_ADD_MODAL_ID) {
        await handleWantedAddModalSubmit(interaction, cfg);
      }
    }
  } catch (e) {
    console.warn('interaction:', e);
    if (!interaction.isRepliable()) return;
    if (interaction.deferred || interaction.replied) return;
    await interaction
      .reply({
        content: 'Временная ошибка. Попробуйте позже.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => undefined);
  }
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild || !message.channel.isThread()) return;
    const cfg = await getConfig();
    if (!isCandidateApplicationContext(message, cfg)) return;

    const requestId = await findCandidateRequestIdByThread(
      api,
      message.channel.id,
    );
    if (!requestId) return;

    const pending = await api.getPendingRequests();
    const row = pending.find((r) => r.id === requestId);
    if (!row) return;
    const data = (row.payload as { data?: Record<string, unknown> }).data;
    const applicantId =
      typeof data?.applicantDiscordUserId === 'string'
        ? data.applicantDiscordUserId.trim()
        : null;
    if (!applicantId || message.author.id === applicantId) return;

    const applicant = await client.users.fetch(applicantId).catch(() => null);
    if (!applicant) return;

    const authorLabel =
      message.member?.displayName?.trim() ||
      message.author.displayName ||
      message.author.username;
    await dmApplicantAboutNewThreadMessage(
      applicant,
      message.channel,
      authorLabel,
      message.content ?? '',
    );
  } catch (e) {
    console.warn('messageCreate: candidate thread notify', e);
  }
});

async function handleReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  if (user.bot) return;
  try {
    if (reaction.partial) {
      await reaction.fetch();
    }
    if (reaction.message.partial) {
      await reaction.message.fetch();
    }
  } catch {
    return;
  }

  const message = reaction.message;
  if (!message.guild || message.author?.id !== client.user?.id) return;
  if (!isApproveEmoji(reaction.emoji.name)) return;
  if (!message.channel.isThread()) return;

  const cfg = await getConfig();
  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  const botId = client.user?.id;

  // Decorative roles
  if (isRoleRequestContext(message as Message, cfg)) {
    if (!canModerateRoleRequest(member, cfg)) return;
    const reqId = await findRoleRequestIdByThread(api, message.channel.id);
    if (!reqId) return;
    try {
      const res = await api.setStatus(reqId, 'approved', user.id);
      if (res.discordRoleSync) {
        await applyDiscordRoleSync(message.guild, res.discordRoleSync);
      }
      if (botId) {
        await removeBotPendingReaction(message as Message, botId);
      }
      await purgeRoleRequestThread(message.channel);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return;
      console.error('role-request approve reaction', e);
    }
    return;
  }

  // Leave
  if (isLeaveRequestContext(message as Message, cfg)) {
    if (!canModerateLeaveRequest(member, cfg)) return;
    const reqId = await findLeaveRequestIdByThread(api, message.channel.id);
    if (!reqId) return;
    try {
      const res = await api.setStatus(reqId, 'approved', user.id);
      if (res.discordRoleSync) {
        await applyDiscordRoleSync(message.guild, res.discordRoleSync);
      }
      if (res.leaveNotify) {
        await postLeaveNotifyMessage(message.guild, api, res.leaveNotify);
      }
      if (botId) {
        await removeBotPendingReaction(message as Message, botId);
      }
      await purgeLeaveRequestThread(message.channel);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return;
      console.error('leave-request approve reaction', e);
    }
  }
}

client.on('messageReactionAdd', (reaction, user) => {
  void handleReaction(reaction, user);
});

loginWithRetries(client, staticEnv.token).catch((err) => {
  console.error('Не удалось войти в Discord:', err);
  process.exit(1);
});
