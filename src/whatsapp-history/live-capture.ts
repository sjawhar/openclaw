import {
  getWhatsAppHistoryChatName,
  getWhatsAppHistoryContactName,
  insertWhatsAppHistoryMessage,
  insertWhatsAppHistoryMessages,
  type WhatsAppHistoryMessageRecord,
  upsertWhatsAppHistoryChat,
  upsertWhatsAppHistoryContact,
} from "./db.js";

type HistoryChat = { id?: string; name?: string; unreadCount?: number };
type HistoryContact = { id?: string; name?: string; notify?: string };
type HistoryQuotedMessage = {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  imageMessage?: { caption?: string };
};
type HistoryMessage = {
  key: {
    remoteJid?: string;
    id?: string;
    fromMe?: boolean;
    participant?: string;
  };
  pushName?: string;
  messageTimestamp?: number | { valueOf?: () => number };
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string; contextInfo?: { stanzaId?: string; quotedMessage?: HistoryQuotedMessage } };
    imageMessage?: { caption?: string };
    videoMessage?: { caption?: string };
    documentMessage?: { caption?: string; fileName?: string };
    audioMessage?: { ptt?: boolean };
    stickerMessage?: unknown;
    contactMessage?: { displayName?: string; vcard?: string };
    contactsArrayMessage?: { contacts?: Array<{ displayName?: string; vcard?: string }> };
    locationMessage?: { name?: string; degreesLatitude?: number; degreesLongitude?: number };
    reactionMessage?: { text?: string };
    pollCreationMessage?: { name?: string };
    pollCreationMessageV3?: { name?: string };
    protocolMessage?: unknown;
  };
};

function normalizeJid(value: string): string {
  return value.trim().replace(/:\d+(?=@)/g, "");
}

function extractTextContent(msg: HistoryMessage): { text: string | null; type: string } {
  const m = msg.message;
  if (!m) {
    return { text: null, type: "unknown" };
  }
  if (m.conversation) {
    return { text: m.conversation, type: "text" };
  }
  if (m.extendedTextMessage?.text) {
    return { text: m.extendedTextMessage.text, type: "text" };
  }
  if (m.imageMessage) {
    return { text: m.imageMessage.caption || null, type: "image" };
  }
  if (m.videoMessage) {
    return { text: m.videoMessage.caption || null, type: "video" };
  }
  if (m.documentMessage) {
    return {
      text: m.documentMessage.caption || m.documentMessage.fileName || null,
      type: "document",
    };
  }
  if (m.audioMessage) {
    return { text: null, type: m.audioMessage.ptt ? "voice" : "audio" };
  }
  if (m.stickerMessage) {
    return { text: null, type: "sticker" };
  }
  if (m.contactMessage) {
    const displayName = m.contactMessage.displayName || "";
    const vcard = m.contactMessage.vcard || "";
    const phoneMatch = vcard.match(/TEL[^:]*:([+\d\s-]+)/gi);
    const phones = phoneMatch
      ? phoneMatch.map((t) => t.replace(/TEL[^:]*:/i, "").trim()).join(", ")
      : "";
    const text = phones ? `${displayName} — ${phones}` : displayName || null;
    return { text, type: "contact" };
  }
  if (m.contactsArrayMessage) {
    const names = (m.contactsArrayMessage.contacts || [])
      .map((c) => {
        const name = c.displayName || "";
        const vcard = c.vcard || "";
        const phoneMatch = vcard.match(/TEL[^:]*:([+\d\s-]+)/gi);
        const phone = phoneMatch
          ? phoneMatch.map((t) => t.replace(/TEL[^:]*:/i, "").trim()).join(", ")
          : "";
        return phone ? `${name} — ${phone}` : name;
      })
      .filter(Boolean);
    return { text: names.join("; ") || null, type: "contact" };
  }
  if (m.locationMessage) {
    return {
      text:
        m.locationMessage.name ||
        `${m.locationMessage.degreesLatitude},${m.locationMessage.degreesLongitude}`,
      type: "location",
    };
  }
  if (m.reactionMessage) {
    return { text: m.reactionMessage.text || null, type: "reaction" };
  }
  if (m.pollCreationMessage || m.pollCreationMessageV3) {
    const poll = m.pollCreationMessage || m.pollCreationMessageV3;
    return { text: poll?.name || null, type: "poll" };
  }
  if (m.protocolMessage) {
    return { text: null, type: "protocol" };
  }
  return { text: null, type: "unknown" };
}

function extractQuotedInfo(msg: HistoryMessage): { quotedId: string | null; quotedText: string | null } {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  if (!contextInfo?.quotedMessage) {
    return { quotedId: null, quotedText: null };
  }
  const quotedId = contextInfo.stanzaId || null;
  let quotedText: string | null = null;
  const qm = contextInfo.quotedMessage;
  if (qm.conversation) {
    quotedText = qm.conversation;
  } else if (qm.extendedTextMessage?.text) {
    quotedText = qm.extendedTextMessage.text;
  } else if (qm.imageMessage?.caption) {
    quotedText = qm.imageMessage.caption;
  }
  return { quotedId, quotedText };
}

function contactPhoneFromJid(jid: string): string | undefined {
  if (!jid.endsWith("@s.whatsapp.net")) {
    return undefined;
  }
  const raw = jid.slice(0, -"@s.whatsapp.net".length);
  return raw || undefined;
}

export function upsertWhatsAppHistoryContacts(contacts: HistoryContact[]): void {
  for (const c of contacts) {
    if (!c.id) {
      continue;
    }
    const jid = normalizeJid(c.id);
    upsertWhatsAppHistoryContact(jid, c.name || undefined, c.notify || undefined, contactPhoneFromJid(jid));
  }
}

export function upsertWhatsAppHistoryChats(chats: HistoryChat[]): void {
  for (const chat of chats) {
    if (!chat.id) {
      continue;
    }
    const jid = normalizeJid(chat.id);
    upsertWhatsAppHistoryChat(jid, chat.name || undefined, jid.endsWith("@g.us"), chat.unreadCount);
  }
}

function waMessageToRecord(msg: HistoryMessage, chatName?: string): WhatsAppHistoryMessageRecord | null {
  const key = msg.key;
  if (!key.remoteJid || !key.id) {
    return null;
  }
  const chatJid = normalizeJid(key.remoteJid);
  const { text, type } = extractTextContent(msg);
  const { quotedId, quotedText } = extractQuotedInfo(msg);
  let senderJid: string | null = null;
  let senderName: string | null = null;
  let senderPushname: string | null = null;
  if (key.participant) {
    senderJid = normalizeJid(key.participant);
  } else if (!chatJid.includes("@g.us")) {
    senderJid = key.fromMe ? null : chatJid;
  }
  if (senderJid) {
    senderName = getWhatsAppHistoryContactName(senderJid);
  }
  senderPushname = msg.pushName || null;
  const timestamp = msg.messageTimestamp
    ? typeof msg.messageTimestamp === "number"
      ? msg.messageTimestamp
      : Number(msg.messageTimestamp)
    : Math.floor(Date.now() / 1000);
  return {
    id: key.id,
    chat_jid: chatJid,
    chat_name: chatName || getWhatsAppHistoryChatName(chatJid) || undefined,
    sender_jid: senderJid || undefined,
    sender_name: senderName || undefined,
    sender_pushname: senderPushname || undefined,
    from_me: key.fromMe || false,
    timestamp,
    message_type: type,
    text_content: text || undefined,
    caption: type !== "text" ? text || undefined : undefined,
    quoted_id: quotedId || undefined,
    quoted_text: quotedText || undefined,
    raw_json: JSON.stringify(msg),
    source: "live",
  };
}

export function captureWhatsAppHistorySet(params: {
  chats: HistoryChat[];
  contacts: HistoryContact[];
  messages: HistoryMessage[];
}): number {
  upsertWhatsAppHistoryContacts(params.contacts);
  upsertWhatsAppHistoryChats(params.chats);
  const records = params.messages
    .map((msg) => waMessageToRecord(msg))
    .filter((msg): msg is WhatsAppHistoryMessageRecord => Boolean(msg));
  return insertWhatsAppHistoryMessages(records);
}

export function captureWhatsAppMessagesUpsert(params: {
  messages: HistoryMessage[];
  type: string;
}): void {
  if (params.type !== "notify" && params.type !== "append") {
    return;
  }
  for (const msg of params.messages) {
    const record = waMessageToRecord(msg);
    if (record) {
      insertWhatsAppHistoryMessage(record);
    }
  }
}
