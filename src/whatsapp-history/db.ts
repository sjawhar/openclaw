import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../config/paths.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

type SqlValue = string | number | bigint | Uint8Array | null;

let db: DatabaseSync | null = null;

function resolveHistoryDbPath(): string {
  return path.join(resolveStateDir(), "data", "whatsapp-history.sqlite");
}

function ensureDb(): DatabaseSync {
  if (db) {
    return db;
  }
  const dbPath = resolveHistoryDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      chat_name TEXT,
      sender_jid TEXT,
      sender_name TEXT,
      sender_pushname TEXT,
      from_me INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      message_type TEXT,
      text_content TEXT,
      caption TEXT,
      quoted_id TEXT,
      quoted_text TEXT,
      raw_json TEXT,
      source TEXT DEFAULT 'live',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text_content,
      caption,
      sender_name,
      chat_name,
      content='messages',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text_content, caption, sender_name, chat_name)
      VALUES (NEW.rowid, NEW.text_content, NEW.caption, NEW.sender_name, NEW.chat_name);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text_content, caption, sender_name, chat_name)
      VALUES ('delete', OLD.rowid, OLD.text_content, OLD.caption, OLD.sender_name, OLD.chat_name);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text_content, caption, sender_name, chat_name)
      VALUES ('delete', OLD.rowid, OLD.text_content, OLD.caption, OLD.sender_name, OLD.chat_name);
      INSERT INTO messages_fts(rowid, text_content, caption, sender_name, chat_name)
      VALUES (NEW.rowid, NEW.text_content, NEW.caption, NEW.sender_name, NEW.chat_name);
    END;

    CREATE TABLE IF NOT EXISTS contacts (
      jid TEXT PRIMARY KEY,
      name TEXT,
      notify TEXT,
      phone TEXT,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      is_group INTEGER DEFAULT 0,
      participant_count INTEGER,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_jid);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_from_me ON messages(from_me);
  `);
  return db;
}

export type WhatsAppHistoryMessageRecord = {
  id: string;
  chat_jid: string;
  chat_name?: string;
  sender_jid?: string;
  sender_name?: string;
  sender_pushname?: string;
  from_me: boolean;
  timestamp: number;
  message_type?: string;
  text_content?: string;
  caption?: string;
  quoted_id?: string;
  quoted_text?: string;
  raw_json?: string;
  source?: string;
};

export type WhatsAppHistorySearchOptions = {
  query?: string;
  chat?: string;
  sender?: string;
  fromMe?: boolean;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
};

export type WhatsAppHistorySearchResult = {
  id: string;
  chat_jid: string;
  chat_name: string | null;
  sender_jid: string | null;
  sender_name: string | null;
  sender_pushname: string | null;
  from_me: boolean;
  timestamp: number;
  text_content: string | null;
  caption: string | null;
  message_type: string | null;
  raw_json: string | null;
};

export function insertWhatsAppHistoryMessage(msg: WhatsAppHistoryMessageRecord): void {
  const db = ensureDb();
  db.prepare(`
    INSERT OR REPLACE INTO messages
    (id, chat_jid, chat_name, sender_jid, sender_name, sender_pushname, from_me,
     timestamp, message_type, text_content, caption, quoted_id, quoted_text, raw_json, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id,
    msg.chat_jid,
    msg.chat_name ?? null,
    msg.sender_jid ?? null,
    msg.sender_name ?? null,
    msg.sender_pushname ?? null,
    msg.from_me ? 1 : 0,
    msg.timestamp,
    msg.message_type ?? null,
    msg.text_content ?? null,
    msg.caption ?? null,
    msg.quoted_id ?? null,
    msg.quoted_text ?? null,
    msg.raw_json ?? null,
    msg.source ?? "live",
  );
}

export function insertWhatsAppHistoryMessages(messages: WhatsAppHistoryMessageRecord[]): number {
  const db = ensureDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages
    (id, chat_jid, chat_name, sender_jid, sender_name, sender_pushname, from_me,
     timestamp, message_type, text_content, caption, quoted_id, quoted_text, raw_json, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const msg of messages) {
      const result = stmt.run(
        msg.id,
        msg.chat_jid,
        msg.chat_name ?? null,
        msg.sender_jid ?? null,
        msg.sender_name ?? null,
        msg.sender_pushname ?? null,
        msg.from_me ? 1 : 0,
        msg.timestamp,
        msg.message_type ?? null,
        msg.text_content ?? null,
        msg.caption ?? null,
        msg.quoted_id ?? null,
        msg.quoted_text ?? null,
        msg.raw_json ?? null,
        msg.source ?? "live",
      );
      if ((result as { changes?: number }).changes) {
        count += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return count;
}

export function upsertWhatsAppHistoryContact(
  jid: string,
  name?: string,
  notify?: string,
  phone?: string,
): void {
  const db = ensureDb();
  db.prepare(`
    INSERT INTO contacts (jid, name, notify, phone, updated_at)
    VALUES (?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(excluded.name, name),
      notify = COALESCE(excluded.notify, notify),
      phone = COALESCE(excluded.phone, phone),
      updated_at = strftime('%s', 'now')
  `).run(jid, name ?? null, notify ?? null, phone ?? null);
}

export function upsertWhatsAppHistoryChat(
  jid: string,
  name?: string,
  isGroup?: boolean,
  participantCount?: number,
): void {
  const db = ensureDb();
  db.prepare(`
    INSERT INTO chats (jid, name, is_group, participant_count, updated_at)
    VALUES (?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(excluded.name, name),
      is_group = COALESCE(excluded.is_group, is_group),
      participant_count = COALESCE(excluded.participant_count, participant_count),
      updated_at = strftime('%s', 'now')
  `).run(jid, name ?? null, isGroup ? 1 : 0, participantCount ?? null);
}

export function getWhatsAppHistoryContactName(jid: string): string | null {
  const db = ensureDb();
  const row = db.prepare(`SELECT name, notify FROM contacts WHERE jid = ?`).get(jid) as
    | { name: string | null; notify: string | null }
    | undefined;
  return row?.name ?? row?.notify ?? null;
}

export function getWhatsAppHistoryChatName(jid: string): string | null {
  const db = ensureDb();
  const row = db.prepare(`SELECT name FROM chats WHERE jid = ?`).get(jid) as
    | { name: string | null }
    | undefined;
  return row?.name ?? null;
}

function resolveChatJids(db: DatabaseSync, chat: string): string[] {
  const jids = new Set<string>();
  const directJids = db
    .prepare(`SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE ?`)
    .all(`%${chat}%`) as { chat_jid: string }[];
  for (const row of directJids) {
    jids.add(row.chat_jid);
  }
  const chatsByName = db.prepare(`SELECT jid FROM chats WHERE name LIKE ?`).all(`%${chat}%`) as {
    jid: string;
  }[];
  for (const row of chatsByName) {
    jids.add(row.jid);
  }
  const contactsByName = db
    .prepare(`SELECT jid FROM contacts WHERE name LIKE ? OR notify LIKE ?`)
    .all(`%${chat}%`, `%${chat}%`) as { jid: string }[];
  for (const row of contactsByName) {
    jids.add(row.jid);
  }
  const resolvedNames = new Set<string>();
  for (const jid of jids) {
    const contact = db.prepare(`SELECT name, notify FROM contacts WHERE jid = ?`).get(jid) as
      | { name: string | null; notify: string | null }
      | undefined;
    if (contact?.name) {
      resolvedNames.add(contact.name);
    }
    if (contact?.notify) {
      resolvedNames.add(contact.notify);
    }
    const chatRow = db.prepare(`SELECT name FROM chats WHERE jid = ?`).get(jid) as
      | { name: string | null }
      | undefined;
    if (chatRow?.name) {
      resolvedNames.add(chatRow.name);
    }
    const msgChatName = db
      .prepare(`SELECT chat_name FROM messages WHERE chat_jid = ? AND chat_name IS NOT NULL LIMIT 1`)
      .get(jid) as { chat_name: string | null } | undefined;
    if (msgChatName?.chat_name) {
      resolvedNames.add(msgChatName.chat_name);
    }
  }
  for (const name of resolvedNames) {
    const chatJids = db.prepare(`SELECT jid FROM chats WHERE name = ?`).all(name) as { jid: string }[];
    for (const row of chatJids) {
      jids.add(row.jid);
    }
    const contactJids = db
      .prepare(`SELECT jid FROM contacts WHERE name = ? OR notify = ?`)
      .all(name, name) as { jid: string }[];
    for (const row of contactJids) {
      jids.add(row.jid);
    }
    const msgJids = db
      .prepare(`SELECT DISTINCT chat_jid FROM messages WHERE chat_name = ?`)
      .all(name) as { chat_jid: string }[];
    for (const row of msgJids) {
      jids.add(row.chat_jid);
    }
  }
  return [...jids];
}

export function searchWhatsAppHistory(
  opts: WhatsAppHistorySearchOptions,
): WhatsAppHistorySearchResult[] {
  const db = ensureDb();
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  if (opts.query) {
    conditions.push(`m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)`);
    params.push(opts.query);
  }
  if (opts.chat) {
    const chatJids = resolveChatJids(db, opts.chat);
    if (chatJids.length > 0) {
      const placeholders = chatJids.map(() => "?").join(", ");
      conditions.push(`(m.chat_jid IN (${placeholders}) OR m.chat_name LIKE ?)`);
      params.push(...chatJids, `%${opts.chat}%`);
    } else {
      conditions.push(`(m.chat_jid LIKE ? OR m.chat_name LIKE ?)`);
      params.push(`%${opts.chat}%`, `%${opts.chat}%`);
    }
  }
  if (opts.sender) {
    conditions.push(`(m.sender_jid LIKE ? OR m.sender_name LIKE ? OR m.sender_pushname LIKE ?)`);
    params.push(`%${opts.sender}%`, `%${opts.sender}%`, `%${opts.sender}%`);
  }
  if (opts.fromMe !== undefined) {
    conditions.push(`m.from_me = ?`);
    params.push(opts.fromMe ? 1 : 0);
  }
  if (opts.since) {
    conditions.push(`m.timestamp >= ?`);
    params.push(opts.since);
  }
  if (opts.until) {
    conditions.push(`m.timestamp <= ?`);
    params.push(opts.until);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const sql = `
    SELECT id, chat_jid, chat_name, sender_jid, sender_name, sender_pushname, from_me,
           timestamp, text_content, caption, message_type, raw_json
    FROM messages m
    ${where}
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);
  const rows = db.prepare(sql).all(...params) as Array<
    Omit<WhatsAppHistorySearchResult, "from_me"> & { from_me: number }
  >;
  return rows.map((row) => ({
    ...row,
    from_me: row.from_me === 1,
  }));
}

export function closeWhatsAppHistoryDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
