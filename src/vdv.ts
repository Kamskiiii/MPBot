/**
 * Опциональная интеграция с бэкендом VDV (включается, только если заданы
 * BACKEND_PUBLIC_URL и VP_DISCORD_BOT_SECRET). Через неё работает «Розыск»
 * (панель, алерты, досье) — данные игрового сервера живут в VDV — и
 * несколько вспомогательных синхронизаций. Всё остальное работает локально
 * и от VDV не зависит.
 */
import { ApiError } from './errors.js';
import type {
  WantedAlertJob,
  WantedBoardPayload,
  WantedClass,
  WantedDossierJob,
  WantedPersonRow,
} from './api.js';

const TIMEOUT_MS = 8_000;

export type VdvRemoteConfig = {
  channelCatalogSyncRequested: boolean;
  wantedPanelChannelId: string | null;
  wantedPanelMessageId: string | null;
  wantedPanelSyncRequested: boolean;
  wantedOperatorRoleIds: string[];
  wantedAlertChannelIds: string[];
  wantedAlertRoleIds: string[];
  wantedAlertGifUrl: string | null;
  wantedDossierChannelId: string | null;
};

export type ChannelMessageDto = {
  id: string;
  content: string;
  createdAt: string;
  authorId: string;
  authorNick: string;
  authorUsername: string;
  imageUrls: string[];
  threadId: string | null;
  threadName: string | null;
  threadMessageCount: number | null;
};

export function createVdvClient(baseUrl: string, secret: string) {
  const root = baseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', 'x-bot-secret': secret };

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${root}/api/vp-agent/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new ApiError(`API ${res.status}`, res.status, await res.text());
    }
    return (await res.json().catch(() => undefined)) as T;
  }
  const enc = encodeURIComponent;

  return {
    getBotConfig: () => call<VdvRemoteConfig>('GET', 'bot-config'),

    ackWantedPanelSync: () =>
      call<void>('PATCH', 'bot-config/panel-sync-ack', { wantedPanel: true }),

    saveChannelCatalog: (
      channels: {
        id: string;
        name: string;
        type: number;
        parentId: string | null;
        position: number;
      }[],
    ) => call<void>('POST', 'channel-catalog', { channels }),

    getPendingChannelMessageJobs: () =>
      call<{ items: { jobId: string; channelId: string; createdAt: string }[] }>(
        'GET',
        'channel-message-jobs/pending',
      ),

    ackChannelMessageJob: (body: {
      jobId: string;
      messages?: ChannelMessageDto[];
      error?: string | null;
    }) => call<void>('POST', 'channel-message-jobs/ack', body),

    setWantedPanelMessageId: (messageId: string) =>
      call<void>('PATCH', 'bot-config/wanted-panel-message', { messageId }),

    getWantedBoard: () => call<WantedBoardPayload>('GET', 'wanted-board'),

    createWantedPerson: (body: {
      fullName: string;
      steam64?: string | null;
      reason: string;
      wantedClass: WantedClass;
      reward: number;
    }) => call<WantedPersonRow>('POST', 'wanted/persons', body),

    deactivateWantedPerson: (id: string) =>
      call<WantedPersonRow>('PATCH', `wanted/persons/${enc(id)}/deactivate`),

    getPendingWantedAlertJobs: () =>
      call<{ items: WantedAlertJob[] }>('GET', 'wanted-alert-jobs/pending'),

    ackWantedAlertJob: (body: {
      jobId: string;
      messageId?: string | null;
      error?: string | null;
    }) => call<void>('POST', 'wanted-alert-jobs/ack', body),

    getPendingWantedDossierJobs: () =>
      call<{ items: WantedDossierJob[] }>('GET', 'wanted-dossier-jobs/pending'),

    ackWantedDossierJob: (body: {
      jobId: string;
      threadId?: string | null;
      starterMessageId?: string | null;
      cardMessageId?: string | null;
      analyticsMessageId?: string | null;
      error?: string | null;
    }) => call<void>('POST', 'wanted-dossier-jobs/ack', body),
  };
}

export type VdvClient = ReturnType<typeof createVdvClient>;
