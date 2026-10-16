import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Настройки из config.json (+ ID сообщений панелей из БД). Поля wanted… и channelCatalogSyncRequested приходят из VDV, если он подключён. */
export type BotConfig = {
  guildId: string | null;
  welcomeChannelId: string | null;
  guestRoleId: string | null;
  candidateRoleId: string | null;
  candidateApplicationChannelId: string | null;
  candidateApplicationApproverRoleIds: string[];
  candidateApprovalAlwaysRoleIds: string[];
  positionRoleIds: string[];
  positionCategoryRoleId: string | null;
  punishmentRoleIds: string[];
  punishmentCategoryRoleId: string | null;
  otherRoleIds: string[];
  otherCategoryRoleId: string | null;
  roleRequestChannelId: string | null;
  roleRequestApproverRoleIds: string[];
  leaveRequestChannelId: string | null;
  leaveApproverRoleIds: string[];
  leaveNotifyChannelId: string | null;
  leaveActiveRoleId: string | null;
  actionsPanelChannelId: string | null;
  actionsPanelMessageId: string | null;
  actionsPanelSyncRequested: boolean;
  welcomePanelTitle: string | null;
  welcomePanelDescription: string | null;
  welcomePanelThumbnailUrl: string | null;
  welcomePanelImageUrl: string | null;
  welcomePanelMessageId: string | null;
  welcomePanelSyncRequested: boolean;
  training: {
    channelId: string | null;
    instructorRoleId: string | null;
    panelTitle: string | null;
    panelDescription: string | null;
    messageId: string | null;
  };
  /** Кто может вызывать /setup-panels и /setup-training. */
  adminDiscordUserIds: string[];
  // --- только через VDV (опционально, см. README) ---
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

/** Часть BotConfig, которую пользователь задаёт в config.json. */
export type FileConfig = Omit<
  BotConfig,
  | 'actionsPanelMessageId'
  | 'actionsPanelSyncRequested'
  | 'welcomePanelMessageId'
  | 'welcomePanelSyncRequested'
  | 'channelCatalogSyncRequested'
  | 'wantedPanelChannelId'
  | 'wantedPanelMessageId'
  | 'wantedPanelSyncRequested'
  | 'wantedOperatorRoleIds'
  | 'wantedAlertChannelIds'
  | 'wantedAlertRoleIds'
  | 'wantedAlertGifUrl'
  | 'wantedDossierChannelId'
  | 'training'
> & { training: Omit<BotConfig['training'], 'messageId'> };

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;
const ids = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map(str).filter((x): x is string => !!x))] : [];

/** Пустые/отсутствующие ключи → null / []; лишние ключи игнорируются. */
export function parseFileConfig(raw: Record<string, unknown>): FileConfig {
  const t = (raw.training ?? {}) as Record<string, unknown>;
  return {
    guildId: str(raw.guildId),
    welcomeChannelId: str(raw.welcomeChannelId),
    guestRoleId: str(raw.guestRoleId),
    candidateRoleId: str(raw.candidateRoleId),
    candidateApplicationChannelId: str(raw.candidateApplicationChannelId),
    candidateApplicationApproverRoleIds: ids(raw.candidateApplicationApproverRoleIds),
    candidateApprovalAlwaysRoleIds: ids(raw.candidateApprovalAlwaysRoleIds),
    positionRoleIds: ids(raw.positionRoleIds),
    positionCategoryRoleId: str(raw.positionCategoryRoleId),
    punishmentRoleIds: ids(raw.punishmentRoleIds),
    punishmentCategoryRoleId: str(raw.punishmentCategoryRoleId),
    otherRoleIds: ids(raw.otherRoleIds),
    otherCategoryRoleId: str(raw.otherCategoryRoleId),
    roleRequestChannelId: str(raw.roleRequestChannelId),
    roleRequestApproverRoleIds: ids(raw.roleRequestApproverRoleIds),
    leaveRequestChannelId: str(raw.leaveRequestChannelId),
    leaveApproverRoleIds: ids(raw.leaveApproverRoleIds),
    leaveNotifyChannelId: str(raw.leaveNotifyChannelId),
    leaveActiveRoleId: str(raw.leaveActiveRoleId),
    actionsPanelChannelId: str(raw.actionsPanelChannelId),
    welcomePanelTitle: str(raw.welcomePanelTitle),
    welcomePanelDescription: str(raw.welcomePanelDescription),
    welcomePanelThumbnailUrl: str(raw.welcomePanelThumbnailUrl),
    welcomePanelImageUrl: str(raw.welcomePanelImageUrl),
    training: {
      channelId: str(t.channelId),
      instructorRoleId: str(t.instructorRoleId),
      panelTitle: str(t.panelTitle),
      panelDescription: str(t.panelDescription),
    },
    adminDiscordUserIds: ids(raw.adminDiscordUserIds),
  };
}

export function loadStaticEnv() {
  const token = (process.env.DISCORD_BOT_TOKEN ?? '').trim();
  if (!token) throw new Error('DISCORD_BOT_TOKEN не задан');

  const rawMc = (process.env.VP_MESSAGE_CONTENT_INTENT ?? '').trim().toLowerCase();
  const messageContentIntent =
    rawMc === '1' || rawMc === 'true' || rawMc === 'yes';

  // VDV-интеграция включается только если заданы ОБА значения.
  const vdvUrl = (process.env.BACKEND_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  const vdvSecret = (process.env.VP_DISCORD_BOT_SECRET ?? '').trim();
  const vdv = vdvUrl && vdvSecret ? { url: vdvUrl, secret: vdvSecret } : null;

  const dataDir = resolve(process.env.DATA_DIR?.trim() || './data');
  const configPath = resolve(process.env.CONFIG_PATH?.trim() || './config.json');

  return { token, messageContentIntent, vdv, dataDir, configPath };
}

export function loadFileConfig(path: string): FileConfig {
  if (!existsSync(path)) throw new Error(`Не найден файл настроек: ${path}`);
  return parseFileConfig(JSON.parse(readFileSync(path, 'utf8')));
}
