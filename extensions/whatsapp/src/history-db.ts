import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { requireNodeSqlite } from "../../../src/memory/sqlite.js";

let db: DatabaseSync | null = null;

function resolveHistoryDbPath(): string {
  return path.join(resolveStateDir(), "data", "whatsapp-history.sqlite");
}

function ensureDb(): DatabaseSync {
  if (db) return db;
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
      raw_json TEXT,
      source TEXT DEFAULT 'live'
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
      lid TEXT,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts(lid);
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      is_group INTEGER DEFAULT 0,
      participant_count INTEGER,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_jid);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  `);
  // Migration: add lid column to existing contacts table
  try { db.exec("ALTER TABLE contacts ADD COLUMN lid TEXT"); } catch { /* already exists */ }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts(lid)"); } catch { /* already exists */ }
  return db;
}

export type HistoryMessageRecord = {
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
  raw_json?: string;
  source?: string;
};

export type HistorySearchRow = {
  id: string;
  chat_jid: string | null;
  chat_name: string | null;
  sender_jid: string | null;
  sender_name: string | null;
  sender_pushname: string | null;
  from_me: boolean;
  timestamp: number;
  text_content: string | null;
  caption: string | null;
  message_type: string | null;
};

export function insertWhatsAppHistoryMessage(msg: HistoryMessageRecord): void {
  const db = ensureDb();
  db.prepare(`
    INSERT OR REPLACE INTO messages
    (id, chat_jid, chat_name, sender_jid, sender_name, sender_pushname, from_me, timestamp, message_type, text_content, caption, raw_json, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    msg.raw_json ?? null,
    msg.source ?? "live",
  );
}

export function insertWhatsAppHistoryMessages(messages: HistoryMessageRecord[]): number {
  const db = ensureDb();
  let count = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const msg of messages) {
      const before = db.prepare("SELECT 1 FROM messages WHERE id = ?").get(msg.id);
      insertWhatsAppHistoryMessage(msg);
      if (!before) count += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return count;
}

export function upsertWhatsAppHistoryContact(jid: string, name?: string, notify?: string, phone?: string, lid?: string): void {
  const db = ensureDb();
  db.prepare(`
    INSERT INTO contacts (jid, name, notify, phone, lid, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(excluded.name, name),
      notify = COALESCE(excluded.notify, notify),
      phone = COALESCE(excluded.phone, phone),
      lid = COALESCE(excluded.lid, lid),
      updated_at = strftime('%s','now')
  `).run(jid, name ?? null, notify ?? null, phone ?? null, lid ?? null);
}

export function upsertWhatsAppHistoryChat(jid: string, name?: string, isGroup?: boolean, participantCount?: number): void {
  const db = ensureDb();
  db.prepare(`
    INSERT INTO chats (jid, name, is_group, participant_count, updated_at)
    VALUES (?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(excluded.name, name),
      is_group = COALESCE(excluded.is_group, is_group),
      participant_count = COALESCE(excluded.participant_count, participant_count),
      updated_at = strftime('%s','now')
  `).run(jid, name ?? null, isGroup ? 1 : 0, participantCount ?? null);
}

export function getWhatsAppHistoryContactName(jid: string): string | null {
  const db = ensureDb();
  // Direct lookup first
  const row = db.prepare('SELECT name, notify FROM contacts WHERE jid = ?').get(jid) as {name?: string|null, notify?: string|null}|undefined;
  if (row?.name ?? row?.notify) return row?.name ?? row?.notify ?? null;
  // If JID is a LID, look up the phone-JID contact that has this LID
  if (jid.endsWith('@lid')) {
    const lidRow = db.prepare('SELECT name, notify FROM contacts WHERE lid = ?').get(jid) as {name?: string|null, notify?: string|null}|undefined;
    return lidRow?.name ?? lidRow?.notify ?? null;
  }
  return null;
}

export function searchWhatsAppHistory(opts: {
  query?: string;
  chat?: string;
  sender?: string;
  fromMe?: boolean;
  since?: number;
  until?: number;
  limit?: number;
}) {
  const db = ensureDb();
  const conditions = [];
  const params = [];
  if (opts.query) {
    conditions.push(`m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)`);
    params.push(opts.query);
  }
  if (opts.chat) {
    conditions.push(`(m.chat_jid LIKE ? OR m.chat_name LIKE ? OR c_direct.name LIKE ? OR c_lid.name LIKE ?)`);
    params.push(`%${opts.chat}%`, `%${opts.chat}%`, `%${opts.chat}%`, `%${opts.chat}%`);
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
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  params.push(limit);
  return db.prepare(`
    SELECT m.id, m.chat_jid,
      COALESCE(m.chat_name, c_direct.name, c_direct.notify, c_lid.name, c_lid.notify) as chat_name,
      m.sender_jid, m.sender_name, m.sender_pushname, m.from_me, m.timestamp, m.text_content, m.caption, m.message_type
    FROM messages m
    LEFT JOIN contacts c_direct ON c_direct.jid = m.chat_jid
    LEFT JOIN contacts c_lid ON c_lid.lid = m.chat_jid
    ${where}
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(...params).map((row) => ({
    ...row,
    from_me: row.from_me === 1,
  })) as HistorySearchRow[];
}
