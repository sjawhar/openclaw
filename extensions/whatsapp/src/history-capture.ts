import { jidNormalizedUser, type Chat, type Contact, type WAMessage } from "@whiskeysockets/baileys";
import {
  getWhatsAppHistoryContactName,
  insertWhatsAppHistoryMessage,
  insertWhatsAppHistoryMessages,
  type HistoryMessageRecord,
  upsertWhatsAppHistoryChat,
  upsertWhatsAppHistoryContact,
} from "./history-db.js";

function contactPhoneFromJid(jid: string): string | undefined {
  return jid.endsWith('@s.whatsapp.net') ? jid.slice(0, -'@s.whatsapp.net'.length) : undefined;
}

function extractTextContent(msg: WAMessage): { text: string | null; type: string } {
  const m = msg.message;
  if (!m) return { text: null, type: 'unknown' };
  if (m.conversation) return { text: m.conversation, type: 'text' };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, type: 'text' };
  if (m.imageMessage) return { text: m.imageMessage.caption || null, type: 'image' };
  if (m.videoMessage) return { text: m.videoMessage.caption || null, type: 'video' };
  if (m.documentMessage) return { text: m.documentMessage.caption || m.documentMessage.fileName || null, type: 'document' };
  if (m.audioMessage) return { text: null, type: m.audioMessage.ptt ? 'voice' : 'audio' };
  if (m.reactionMessage) return { text: m.reactionMessage.text || null, type: 'reaction' };
  if (m.pollCreationMessage || m.pollCreationMessageV3) return { text: (m.pollCreationMessage || m.pollCreationMessageV3)?.name || null, type: 'poll' };
  return { text: null, type: 'unknown' };
}

function waMessageToRecord(msg: WAMessage, chatName?: string, source = 'live'): HistoryMessageRecord | null {
  const key = msg.key;
  if (!key.remoteJid || !key.id) return null;
  const chatJid = jidNormalizedUser(key.remoteJid);
  const { text, type } = extractTextContent(msg);
  let senderJid: string | null = null;
  let senderName: string | null = null;
  if (key.participant) {
    senderJid = jidNormalizedUser(key.participant);
  } else if (!chatJid.includes('@g.us')) {
    senderJid = key.fromMe ? null : chatJid;
  }
  if (senderJid) senderName = getWhatsAppHistoryContactName(senderJid);
  const ts = msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now()/1000);
  return {
    id: key.id,
    chat_jid: chatJid,
    chat_name: chatName,
    sender_jid: senderJid || undefined,
    sender_name: senderName || undefined,
    sender_pushname: msg.pushName || undefined,
    from_me: key.fromMe || false,
    timestamp: ts,
    message_type: type,
    text_content: text || undefined,
    caption: type !== 'text' ? text || undefined : undefined,
    raw_json: JSON.stringify(msg),
    source: source,
  };
}

export type HistoryContactLike = {
  id?: string | null;
  name?: string | null;
  notify?: string | null;
  lid?: string | null;
};

export function upsertWhatsAppHistoryContacts(contacts: HistoryContactLike[]): void {
  for (const c of contacts) {
    if (!c.id) continue;
    const jid = jidNormalizedUser(c.id);
    const lid = c.lid ? jidNormalizedUser(c.lid) : undefined;
    upsertWhatsAppHistoryContact(jid, c.name || undefined, c.notify || undefined, contactPhoneFromJid(jid), lid);
  }
}

export function upsertWhatsAppHistoryChats(chats: Chat[]): void {
  for (const chat of chats) {
    if (!chat.id) continue;
    const jid = jidNormalizedUser(chat.id);
    upsertWhatsAppHistoryChat(
      jid,
      chat.name || undefined,
      jid.endsWith('@g.us'),
      typeof chat.unreadCount === 'number' ? chat.unreadCount : undefined,
    );
  }
}

export function captureWhatsAppHistorySet(params: { chats: Chat[]; contacts: Contact[]; messages: WAMessage[] }): number {
  upsertWhatsAppHistoryContacts(params.contacts);
  upsertWhatsAppHistoryChats(params.chats);
  let filtered = 0;
  const records: HistoryMessageRecord[] = [];
  for (const m of params.messages) {
    const rec = waMessageToRecord(m, undefined, 'history');
    if (rec) {
      records.push(rec);
    } else {
      filtered++;
      // Log the first few filtered messages for debugging
      if (filtered <= 5) {
        console.warn(`[HISTORY-DIAG] waMessageToRecord returned null: remoteJid=${m.key?.remoteJid} id=${m.key?.id} hasMessage=${!!m.message}`);
      }
    }
  }
  if (filtered > 0) {
    console.warn(`[HISTORY-DIAG] ${filtered}/${params.messages.length} messages filtered out by waMessageToRecord`);
  }
  return insertWhatsAppHistoryMessages(records);
}

export function captureWhatsAppMessagesUpsert(params: { messages: WAMessage[]; type?: string }): void {
  if (params.type !== 'notify' && params.type !== 'append') return;
  for (const msg of params.messages) {
    const record = waMessageToRecord(msg);
    if (record) insertWhatsAppHistoryMessage(record);
  }
}
