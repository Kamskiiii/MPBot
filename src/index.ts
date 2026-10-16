import './load-env.js';
/** До discord.js: патчит WebSocket при DISCORD_PROXY. */
import { getDiscordProxyRestAgent } from './proxy-setup.js';
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
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

function isApproveEmoji(name: string | null): boolean {
  return name === '✅' || name === '✔️' || name === '☑';
}

async function removeBotPendingReaction(
  client: Client,
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

client.once('clientReady', () => {
  console.log(`Агент ВП авторизован: ${client.user?.tag}`);
  if (!staticEnv.messageContentIntent) {
    console.warn(
      'VP_MESSAGE_CONTENT_INTENT не включён: бот стартует без privileged Message Content. ' +
        'Лента на сайте будет без текста, пока в Developer Portal не включите Message Content Intent ' +
        'и не зададите VP_MESSAGE_CONTENT_INTENT=true.',
    );
  }

  const panelPoller = startPanelSyncPoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  panelPoller.start();

  const catalogPoller = startChannelCatalogPoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  catalogPoller.start();

  const messagePoller = startChannelMessagePoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  messagePoller.start();

  const leaveNotifyPoller = startLeaveNotifyPoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  leaveNotifyPoller.start();

  const formThreadPoller = startFormDiscordThreadPoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  formThreadPoller.start();

  const investigatorPoller = startInvestigatorChoicesPoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  investigatorPoller.start();

  const wantedAlertPoller = startWantedAlertPoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  wantedAlertPoller.start();

  const wantedDossierPoller = startWantedDossierPoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  wantedDossierPoller.start();
});

loginWithRetries(client, staticEnv.token).catch((err) => {
  console.error('Не удалось авторизоваться в Discord:', err);
  process.exit(1);
});