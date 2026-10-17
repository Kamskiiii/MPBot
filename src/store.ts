import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type RequestRow = {
  id: string;
  payload: { operation?: string; data?: Record<string, unknown> };
  status: string;
};

export type LeaveRow = {
  id: string;
  applicantDiscordUserId: string;
  discordDisplayName: string | null;
  startDate: string;
  endDate: string;
  reason: string | null;
  status: string;
  discordThreadId: string | null;
  approvedByDiscordUserId: string | null;
  notifyChannelId: string | null;
  notifyMessageId: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS leaves (
  id TEXT PRIMARY KEY,
  applicant TEXT NOT NULL,
  display_name TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,
  thread_id TEXT,
  approved_by TEXT,
  notify_channel_id TEXT,
  notify_message_id TEXT,
  notify_edit_requested INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

type RawRequest = { id: string; payload: string; status: string };
type RawLeave = {
  id: string;
  applicant: string;
  display_name: string | null;
  start_date: string;
  end_date: string;
  reason: string | null;
  status: string;
  thread_id: string | null;
  approved_by: string | null;
  notify_channel_id: string | null;
  notify_message_id: string | null;
};

const toRequest = (r: RawRequest): RequestRow => ({
  id: r.id,
  payload: JSON.parse(r.payload),
  status: r.status,
});

const toLeave = (r: RawLeave): LeaveRow => ({
  id: r.id,
  applicantDiscordUserId: r.applicant,
  discordDisplayName: r.display_name,
  startDate: r.start_date,
  endDate: r.end_date,
  reason: r.reason,
  status: r.status,
  discordThreadId: r.thread_id,
  approvedByDiscordUserId: r.approved_by,
  notifyChannelId: r.notify_channel_id,
  notifyMessageId: r.notify_message_id,
});

/** `path` — файл SQLite или ':memory:' (тесты). */
export function openStore(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  return {
    tx: <T>(fn: () => T): T => db.transaction(fn)(),

    kvGet(key: string): string | null {
      const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return r?.value ?? null;
    },
    kvSet(key: string, value: string): void {
      db.prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, value);
    },

    insertRequest(payload: RequestRow['payload']): RequestRow {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO requests (id, payload, status) VALUES (?, ?, 'pending')",
      ).run(id, JSON.stringify(payload));
      return { id, payload, status: 'pending' };
    },
    getRequest(id: string): RequestRow | null {
      const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as
        | RawRequest
        | undefined;
      return r ? toRequest(r) : null;
    },
    pendingRequests(): RequestRow[] {
      return (
        db
          .prepare(
            "SELECT * FROM requests WHERE status = 'pending' ORDER BY created_at, rowid",
          )
          .all() as RawRequest[]
      ).map(toRequest);
    },
    updateRequest(row: RequestRow): void {
      db.prepare('UPDATE requests SET payload = ?, status = ? WHERE id = ?').run(
        JSON.stringify(row.payload),
        row.status,
        row.id,
      );
    },

    insertLeave(l: Omit<LeaveRow, 'id' | 'status'>): LeaveRow {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO leaves (id, applicant, display_name, start_date, end_date, reason, status,
           thread_id, approved_by, notify_channel_id)
         VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)`,
      ).run(
        id,
        l.applicantDiscordUserId,
        l.discordDisplayName,
        l.startDate,
        l.endDate,
        l.reason,
        l.discordThreadId,
        l.approvedByDiscordUserId,
        l.notifyChannelId,
      );
      return { ...l, id, status: 'approved' };
    },
    setLeaveNotifyMessage(id: string, channelId: string, messageId: string): boolean {
      return (
        db
          .prepare(
            "UPDATE leaves SET notify_channel_id = ?, notify_message_id = ?, updated_at = datetime('now') WHERE id = ?",
          )
          .run(channelId, messageId, id).changes > 0
      );
    },
    /** approved с endDate < today → expired + запрос на правку уведомления. */
    expireLeaves(todayYmd: string): number {
      return db
        .prepare(
          `UPDATE leaves SET status = 'expired', notify_edit_requested = 1, updated_at = datetime('now')
           WHERE status = 'approved' AND end_date < ?`,
        )
        .run(todayYmd).changes;
    },
    pendingLeaveEdits(limit: number): LeaveRow[] {
      return (
        db
          .prepare(
            "SELECT * FROM leaves WHERE notify_edit_requested = 1 AND status = 'expired' ORDER BY updated_at LIMIT ?",
          )
          .all(limit) as RawLeave[]
      ).map(toLeave);
    },
    ackLeaveEdit(id: string): void {
      db.prepare(
        "UPDATE leaves SET notify_edit_requested = 0, updated_at = datetime('now') WHERE id = ?",
      ).run(id);
    },

    close: () => db.close(),
  };
}

export type Store = ReturnType<typeof openStore>;
