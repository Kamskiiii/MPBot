import type { VdvClient, VdvRemoteConfig } from './vdv.js';
import { ApiError } from './errors.js';
import type { BotConfig, FileConfig } from './config.js';
import type { Store } from './store.js';

export { ApiError };

export type VpPendingRow = {
  id: string;
  payload: Record<string, unknown>;
  status: string;
};

export type VpDiscordRoleSyncDto = {
  targetDiscordUserId: string;
  addRoleIds: string[];
  removeRoleIds: string[];
};

export type SetVpStatusResponse = {
  request: VpPendingRow;
  discordRoleSync: VpDiscordRoleSyncDto | null;
  leaveNotify: VpLeaveNotifyPayload | null;
};

export type VpLeaveNotifyPayload = {
  leaveId: string;
  channelId: string;
  applicantDiscordUserId: string;
  discordDisplayName: string | null;
  startDate: string;
  endDate: string;
  reason: string | null;
};

export type VpLeaveNotifyEditJob = {
  leaveId: string;
  channelId: string;
  messageId: string;
  applicantDiscordUserId: string;
  discordDisplayName: string | null;
  startDate: string;
  endDate: string;
  reason: string | null;
  approvedByDiscordUserId: string | null;
  leaveActiveRoleId: string | null;
};

export type CreateVpRequestBody = {
  type: string;
  payload: Record<string, unknown>;
};

export type WantedClass = 'red' | 'yellow' | 'blue';

export type WantedBoardPerson = {
  id: string;
  fullName: string;
  steam64: string | null;
  reason: string;
  wantedClass: WantedClass;
  reward: number;
  online: boolean;
  serverName: string | null;
};

export type WantedBoardPayload = {
  panelChannelId: string | null;
  panelMessageId: string | null;
  panelSyncRequested: boolean;
  operatorRoleIds: string[];
  persons: WantedBoardPerson[];
  onlinePersonIds: string[];
  fingerprint: string;
};

export type WantedPersonRow = {
  id: string;
  fullName: string;
  steam64: string | null;
  reason: string;
  wantedClass: WantedClass;
  reward: number;
  active: boolean;
};

export type WantedAlertJob = {
  id: string;
  kind: 'post' | 'edit';
  sessionId: string;
  personId: string;
  channelId: string;
  messageId: string | null;
  fullName: string;
  reason: string;
  wantedClass: WantedClass;
  reward: number;
  serverName: string | null;
  gifUrl: string | null;
  pingRoleIds: string[];
};

export type WantedDossierPayload = {
  fullName: string;
  reason: string;
  wantedClass: WantedClass;
  reward: number;
  steam64: string | null;
  siteUrl: string | null;
  online: boolean;
  serverName: string | null;
  typicalWindow: string;
  medianSession: string;
  sessionCount: number;
  heatmapLines: string[];
  anomalies: string[];
  coPresence: Array<{
    name: string;
    unit: string | null;
    overlap: string;
    lift: string;
  }>;
  reliable: boolean;
  operatorRoleIds: string[];
  threadName: string;
  closed: boolean;
};

export type WantedDossierJob = {
  id: string;
  kind: 'open' | 'update' | 'close';
  personId: string;
  channelId: string;
  threadId: string | null;
  starterMessageId: string | null;
  cardMessageId: string | null;
  analyticsMessageId: string | null;
  payload: WantedDossierPayload;
};

export const CANDIDATE_OP = 'candidate_application';
export const DECORATIVE_ROLE_OP = 'decorative_role_request';
export const LEAVE_OP = 'leave_request';
const SUPPORTED_OPS = new Set([CANDIDATE_OP, DECORATIVE_ROLE_OP, LEAVE_OP]);
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const KV_WELCOME_MSG = 'welcomePanel.messageId';
const KV_ACTIONS_MSG = 'actionsPanel.messageId';
const KV_TRAINING_MSG = 'training.messageId';
const KV_WELCOME_SYNC = 'welcomePanel.syncRequested';
const KV_ACTIONS_SYNC = 'actionsPanel.syncRequested';

const REMOTE_METHODS = [
  'saveChannelCatalog',
  'getPendingChannelMessageJobs',
  'ackChannelMessageJob',
  'setWantedPanelMessageId',
  'getWantedBoard',
  'createWantedPerson',
  'deactivateWantedPerson',
  'getPendingWantedAlertJobs',
  'ackWantedAlertJob',
  'getPendingWantedDossierJobs',
  'ackWantedDossierJob',
] as const;

const REMOTE_TTL_MS = 15_000;
const REMOTE_RETRY_MS = 60_000;

const bad = (msg: string) => new ApiError(msg, 400);
const trimmed = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * Все методы, кроме REMOTE_METHODS, работают локально (SQLite + config.json).
 * REMOTE_METHODS идут в VDV и вызываются, только если VDV подключён.
 */
export function createApiClient(deps: {
  store: Store;
  file: FileConfig;
  vdv: VdvClient | null;
}) {
  const { store, file, vdv } = deps;

  let remoteCfg: VdvRemoteConfig | null = null;
  let remoteAt = 0;
  let remoteRetryAt = 0;
  async function remoteConfig(): Promise<VdvRemoteConfig | null> {
    if (!vdv) return null;
    const now = Date.now();
    if (remoteCfg && now - remoteAt < REMOTE_TTL_MS) return remoteCfg;
    if (now < remoteRetryAt) return remoteCfg;
    try {
      remoteCfg = await vdv.getBotConfig();
      remoteAt = now;
    } catch (e) {
      remoteRetryAt = now + REMOTE_RETRY_MS;
      console.warn('vdv: не удалось получить bot-config', e instanceof Error ? e.message : e);
    }
    return remoteCfg;
  }

  const needVdv = (): VdvClient => {
    if (!vdv) throw new ApiError('Интеграция с VDV отключена', 503);
    return vdv;
  };
  const remote = Object.fromEntries(
    REMOTE_METHODS.map((m) => [
      m,
      async (...args: unknown[]) =>
        (needVdv()[m] as (...a: unknown[]) => unknown)(...args),
    ]),
  ) as Pick<VdvClient, (typeof REMOTE_METHODS)[number]>;

  function validateCandidate(d: Record<string, unknown>): void {
    if (!trimmed(d.applicantDiscordUserId)) throw bad('Нужен applicantDiscordUserId');
    if (!trimmed(d.fullName)) throw bad('Нужно ФИО');
    if (!trimmed(d.age)) throw bad('Нужен возраст');
    if (!trimmed(d.hoursPerWeek)) throw bad('Нужно количество часов в неделю');
    if (!trimmed(d.armaExperience)) throw bad('Нужен опыт в Arma 3');
    if (!trimmed(d.threadId)) throw bad('Нужен threadId');
  }

  /** Нормализует d.positionRoleId / d.otherRoleIds по спискам из config.json. */
  function validateDecorative(d: Record<string, unknown>): void {
    if (!trimmed(d.applicantDiscordUserId)) throw bad('Нужен applicantDiscordUserId');
    if (!trimmed(d.threadId)) throw bad('Нужен threadId');

    let positionRoleId: string | null = null;
    if (d.positionRoleId != null && d.positionRoleId !== '') {
      if (typeof d.positionRoleId !== 'string') throw bad('positionRoleId должен быть строкой');
      const pid = d.positionRoleId.trim();
      if (!file.positionRoleIds.includes(pid)) throw bad('Выбранная должность не из списка настроек');
      positionRoleId = pid;
    }

    const otherRoleIds: string[] = [];
    if (d.otherRoleIds != null) {
      if (!Array.isArray(d.otherRoleIds)) throw bad('otherRoleIds должен быть массивом');
      for (const id of d.otherRoleIds) {
        const tid = trimmed(id);
        if (!tid) continue;
        if (!file.otherRoleIds.includes(tid)) {
          throw bad(`Роль «Прочее» ${tid} не из списка настроек`);
        }
        otherRoleIds.push(tid);
      }
    }
    if (!positionRoleId && otherRoleIds.length === 0) {
      throw bad('Выберите должность и/или хотя бы одну роль из «Прочее»');
    }
    d.positionRoleId = positionRoleId;
    d.otherRoleIds = [...new Set(otherRoleIds)];
  }

  function validateLeave(d: Record<string, unknown>): void {
    if (!trimmed(d.applicantDiscordUserId)) throw bad('Нужен applicantDiscordUserId');
    if (!trimmed(d.threadId)) throw bad('Нужен threadId');
    const start = trimmed(d.startDate);
    const end = trimmed(d.endDate);
    if (!YMD_RE.test(start)) throw bad('startDate должен быть YYYY-MM-DD');
    if (!YMD_RE.test(end)) throw bad('endDate должен быть YYYY-MM-DD');
    if (start > end) throw bad('Дата начала позже даты окончания');
    if (d.reason != null && typeof d.reason !== 'string') throw bad('reason должен быть строкой');
  }

  function candidateRoleSync(data: Record<string, unknown>): VpDiscordRoleSyncDto | null {
    const applicant = trimmed(data.applicantDiscordUserId);
    const pid = trimmed(data.positionRoleId);
    if (!applicant || !pid || !file.positionRoleIds.includes(pid)) return null;

    const addRoleIds = [pid];
    for (const id of [
      file.positionCategoryRoleId,
      file.punishmentCategoryRoleId,
      file.otherCategoryRoleId,
      ...file.candidateApprovalAlwaysRoleIds,
    ]) {
      if (id) addRoleIds.push(id);
    }
    const removeRoleIds = file.positionRoleIds.filter((id) => id !== pid);
    if (file.guestRoleId) removeRoleIds.push(file.guestRoleId);
    return {
      targetDiscordUserId: applicant,
      addRoleIds: [...new Set(addRoleIds)],
      removeRoleIds: [...new Set(removeRoleIds)],
    };
  }

  function decorativeRoleSync(data: Record<string, unknown>): VpDiscordRoleSyncDto | null {
    const applicant = trimmed(data.applicantDiscordUserId);
    if (!applicant) return null;
    const addRoleIds: string[] = [];
    const removeRoleIds: string[] = [];

    const pid = trimmed(data.positionRoleId);
    if (pid && file.positionRoleIds.includes(pid)) {
      addRoleIds.push(pid);
      removeRoleIds.push(...file.positionRoleIds.filter((id) => id !== pid));
    }
    if (Array.isArray(data.otherRoleIds)) {
      for (const id of data.otherRoleIds) {
        const tid = trimmed(id);
        if (tid && file.otherRoleIds.includes(tid)) addRoleIds.push(tid);
      }
    }
    if (!addRoleIds.length && !removeRoleIds.length) return null;
    return {
      targetDiscordUserId: applicant,
      addRoleIds: [...new Set(addRoleIds)],
      removeRoleIds: [...new Set(removeRoleIds)],
    };
  }

  /** Создаёт approved-отпуск; возвращает notify + role sync для бота. */
  function approveLeave(
    data: Record<string, unknown>,
    approver: string | null,
  ): { leaveNotify: VpLeaveNotifyPayload | null; discordRoleSync: VpDiscordRoleSyncDto | null } {
    const applicant = trimmed(data.applicantDiscordUserId);
    const startDate = trimmed(data.startDate);
    const endDate = trimmed(data.endDate);
    if (!applicant || !startDate || !endDate) return { leaveNotify: null, discordRoleSync: null };

    const channelId = file.leaveNotifyChannelId;
    const leave = store.insertLeave({
      applicantDiscordUserId: applicant,
      discordDisplayName: trimmed(data.discordDisplayName) || null,
      startDate,
      endDate,
      reason: trimmed(data.reason) || null,
      discordThreadId: trimmed(data.threadId) || null,
      approvedByDiscordUserId: approver,
      notifyChannelId: channelId,
      notifyMessageId: null,
    });
    return {
      discordRoleSync: file.leaveActiveRoleId
        ? { targetDiscordUserId: applicant, addRoleIds: [file.leaveActiveRoleId], removeRoleIds: [] }
        : null,
      leaveNotify: channelId
        ? {
            leaveId: leave.id,
            channelId,
            applicantDiscordUserId: applicant,
            discordDisplayName: leave.discordDisplayName,
            startDate,
            endDate,
            reason: leave.reason,
          }
        : null,
    };
  }

  return {
    ...remote,

    async getBotConfig(): Promise<BotConfig> {
      const rc = await remoteConfig();
      return {
        ...file,
        training: { ...file.training, messageId: store.kvGet(KV_TRAINING_MSG) },
        welcomePanelMessageId: store.kvGet(KV_WELCOME_MSG),
        welcomePanelSyncRequested: store.kvGet(KV_WELCOME_SYNC) === '1',
        actionsPanelMessageId: store.kvGet(KV_ACTIONS_MSG),
        actionsPanelSyncRequested: store.kvGet(KV_ACTIONS_SYNC) === '1',
        channelCatalogSyncRequested: rc?.channelCatalogSyncRequested ?? false,
        wantedPanelChannelId: rc?.wantedPanelChannelId ?? null,
        wantedPanelMessageId: rc?.wantedPanelMessageId ?? null,
        wantedPanelSyncRequested: rc?.wantedPanelSyncRequested ?? false,
        wantedOperatorRoleIds: rc?.wantedOperatorRoleIds ?? [],
        wantedAlertChannelIds: rc?.wantedAlertChannelIds ?? [],
        wantedAlertRoleIds: rc?.wantedAlertRoleIds ?? [],
        wantedAlertGifUrl: rc?.wantedAlertGifUrl ?? null,
        wantedDossierChannelId: rc?.wantedDossierChannelId ?? null,
      };
    },

    /** Вместо кнопок «обновить панель» на сайте: старт бота и /setup-panels. */
    requestPanelSync(): void {
      store.kvSet(KV_WELCOME_SYNC, '1');
      store.kvSet(KV_ACTIONS_SYNC, '1');
    },

    async setWelcomePanelMessageId(messageId: string): Promise<void> {
      store.kvSet(KV_WELCOME_MSG, messageId);
    },
    async setActionsPanelMessageId(messageId: string): Promise<void> {
      store.kvSet(KV_ACTIONS_MSG, messageId);
    },
    async setTrainingPanelMessageId(messageId: string): Promise<void> {
      store.kvSet(KV_TRAINING_MSG, messageId);
    },

    async ackPanelSync(body: {
      welcomePanel?: boolean;
      actionsPanel?: boolean;
      wantedPanel?: boolean;
    }): Promise<void> {
      if (body.welcomePanel) store.kvSet(KV_WELCOME_SYNC, '0');
      if (body.actionsPanel) store.kvSet(KV_ACTIONS_SYNC, '0');
      if (body.wantedPanel) await needVdv().ackWantedPanelSync();
    },

    async createRequest(body: CreateVpRequestBody): Promise<VpPendingRow> {
      if (!SUPPORTED_OPS.has(body.type)) {
        throw bad(`Тип заявки «${body.type}» не поддерживается`);
      }
      const data = { ...body.payload };
      if (body.type === CANDIDATE_OP) validateCandidate(data);
      else if (body.type === DECORATIVE_ROLE_OP) validateDecorative(data);
      else validateLeave(data);

      const applicant = trimmed(data.applicantDiscordUserId);
      const dup = store.pendingRequests().some(
        (r) =>
          r.payload.operation === body.type &&
          trimmed(r.payload.data?.applicantDiscordUserId) === applicant,
      );
      if (dup) {
        throw new ApiError(
          body.type === CANDIDATE_OP
            ? 'У вас уже есть необработанная заявка на вступление'
            : body.type === DECORATIVE_ROLE_OP
              ? 'У вас уже есть необработанная заявка на роли'
              : 'У вас уже есть необработанная заявка на отпуск',
          409,
        );
      }
      return store.insertRequest({ operation: body.type, data });
    },

    async getPendingRequests(): Promise<VpPendingRow[]> {
      return store.pendingRequests();
    },

    async setStatus(
      id: string,
      status: 'approved' | 'rejected',
      moderatorDiscordUserId?: string,
      opts?: { positionRoleId?: string },
    ): Promise<SetVpStatusResponse> {
      return store.tx(() => {
        const row = store.getRequest(id);
        if (!row) throw new ApiError('Заявка не найдена', 404);
        if (row.status !== 'pending') throw new ApiError('Заявка уже обработана', 409);

        const op = row.payload.operation;
        const data = row.payload.data ?? {};
        const approved = status === 'approved';

        if (approved && op === CANDIDATE_OP) {
          const pid = opts?.positionRoleId?.trim();
          if (!pid) throw bad('Для одобрения заявки на вступление нужна должность (positionRoleId)');
          if (!file.positionRoleIds.includes(pid)) throw bad('Выбранная должность не из списка настроек');
          data.positionRoleId = pid;
          row.payload = { ...row.payload, data };
        }
        row.status = status;
        store.updateRequest(row);

        let discordRoleSync: VpDiscordRoleSyncDto | null = null;
        let leaveNotify: VpLeaveNotifyPayload | null = null;
        if (approved) {
          if (op === CANDIDATE_OP) discordRoleSync = candidateRoleSync(data);
          else if (op === DECORATIVE_ROLE_OP) discordRoleSync = decorativeRoleSync(data);
          else if (op === LEAVE_OP) {
            ({ leaveNotify, discordRoleSync } = approveLeave(
              data,
              moderatorDiscordUserId?.trim() || null,
            ));
          }
        }
        return { request: row, discordRoleSync, leaveNotify };
      });
    },

    async setLeaveNotifyMessage(
      leaveId: string,
      channelId: string,
      messageId: string,
    ): Promise<void> {
      if (!store.setLeaveNotifyMessage(leaveId, channelId.trim(), messageId.trim())) {
        throw new ApiError('Отпуск не найден', 404);
      }
    },

    /** Заодно закрывает отпуска, у которых endDate уже прошёл (UTC). */
    async getPendingLeaveNotifyEdits(): Promise<{ items: VpLeaveNotifyEditJob[] }> {
      store.expireLeaves(new Date().toISOString().slice(0, 10));
      return {
        items: store.pendingLeaveEdits(10).map((l) => ({
          leaveId: l.id,
          channelId: l.notifyChannelId ?? '',
          messageId: l.notifyMessageId ?? '',
          applicantDiscordUserId: l.applicantDiscordUserId,
          discordDisplayName: l.discordDisplayName,
          startDate: l.startDate,
          endDate: l.endDate,
          reason: l.reason,
          approvedByDiscordUserId: l.approvedByDiscordUserId,
          leaveActiveRoleId: file.leaveActiveRoleId,
        })),
      };
    },

    async ackLeaveNotifyEdit(leaveId: string, _error?: string | null): Promise<void> {
      store.ackLeaveEdit(leaveId);
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
