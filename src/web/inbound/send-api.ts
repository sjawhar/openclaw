import type { AnyMessageContent, WAPresence } from "@whiskeysockets/baileys";
import { loadConfig } from "../../config/config.js";
import { recordChannelActivity } from "../../infra/channel-activity.js";
import {
  getWhatsAppHistoryContactName,
  insertWhatsAppHistoryMessage,
  upsertWhatsAppHistoryChat,
  upsertWhatsAppHistoryContact,
} from "../../whatsapp-history/db.js";
import { toWhatsappJid } from "../../utils.js";
import { readContactStore } from "../contacts-store.js";
import { resolveWhatsAppAccount } from "../accounts.js";
import type { ActiveWebSendOptions } from "../active-listener.js";

function recordWhatsAppOutbound(accountId: string) {
  recordChannelActivity({
    channel: "whatsapp",
    accountId,
    direction: "outbound",
  });
}

function resolveOutboundMessageId(result: unknown): string {
  return typeof result === "object" && result && "key" in result
    ? String((result as { key?: { id?: string } }).key?.id ?? "unknown")
    : "unknown";
}

function lookupWhatsAppContactMetadata(params: {
  accountId: string;
  jid: string;
}): { name?: string; phone?: string } {
  try {
    const cfg = loadConfig();
    const account = resolveWhatsAppAccount({ cfg, accountId: params.accountId });
    const contacts = readContactStore(account.authDir);
    const direct = contacts[params.jid];
    if (direct) {
      return {
        name: direct.name || direct.notify || undefined,
        phone: direct.phone,
      };
    }
  } catch {
  }
  return {
    name: getWhatsAppHistoryContactName(params.jid) ?? undefined,
    phone: params.jid.endsWith("@s.whatsapp.net")
      ? params.jid.slice(0, -"@s.whatsapp.net".length)
      : undefined,
  };
}

function resolveWhatsAppExistenceResult(entry: unknown): { exists: boolean; jid?: string } {
  if (!entry || typeof entry !== "object") {
    return { exists: false };
  }
  const candidate = entry as { exists?: unknown; jid?: unknown };
  return {
    exists: candidate.exists === true,
    jid: typeof candidate.jid === "string" ? candidate.jid : undefined,
  };
}

export function createWebSendApi(params: {
  sock: {
    sendMessage: (jid: string, content: AnyMessageContent) => Promise<unknown>;
    sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
    onWhatsApp?: (jid: string) => Promise<unknown>;
  };
  defaultAccountId: string;
}) {
  return {
    ensureTargetExists: async (to: string): Promise<void> => {
      const onWhatsApp = params.sock.onWhatsApp;
      if (!onWhatsApp) {
        return;
      }
      const jid = toWhatsappJid(to);
      if (!jid.endsWith("@s.whatsapp.net")) {
        return;
      }
      const result = await onWhatsApp(jid);
      const first = Array.isArray(result) ? result[0] : result;
      const resolved = resolveWhatsAppExistenceResult(first);
      if (resolved.exists) {
        return;
      }
      throw new Error(`WhatsApp target is not registered: ${to}`);
    },
    sendMessage: async (
      to: string,
      text: string,
      mediaBuffer?: Buffer,
      mediaType?: string,
      sendOptions?: ActiveWebSendOptions,
    ): Promise<{ messageId: string }> => {
      await (async () => {
        const onWhatsApp = params.sock.onWhatsApp;
        if (!onWhatsApp) {
          return;
        }
        const jid = toWhatsappJid(to);
        if (!jid.endsWith("@s.whatsapp.net")) {
          return;
        }
        const result = await onWhatsApp(jid);
        const first = Array.isArray(result) ? result[0] : result;
        const resolved = resolveWhatsAppExistenceResult(first);
        if (!resolved.exists) {
          throw new Error(`WhatsApp target is not registered: ${to}`);
        }
      })();
      const jid = toWhatsappJid(to);
      let payload: AnyMessageContent;
      if (mediaBuffer && mediaType) {
        if (mediaType.startsWith("image/")) {
          payload = {
            image: mediaBuffer,
            caption: text || undefined,
            mimetype: mediaType,
          };
        } else if (mediaType.startsWith("audio/")) {
          payload = { audio: mediaBuffer, ptt: true, mimetype: mediaType };
        } else if (mediaType.startsWith("video/")) {
          const gifPlayback = sendOptions?.gifPlayback;
          payload = {
            video: mediaBuffer,
            caption: text || undefined,
            mimetype: mediaType,
            ...(gifPlayback ? { gifPlayback: true } : {}),
          };
        } else {
          const fileName = sendOptions?.fileName?.trim() || "file";
          payload = {
            document: mediaBuffer,
            fileName,
            caption: text || undefined,
            mimetype: mediaType,
          };
        }
      } else {
        payload = { text };
      }
      const result = await params.sock.sendMessage(jid, payload);
      const accountId = sendOptions?.accountId ?? params.defaultAccountId;
      recordWhatsAppOutbound(accountId);
      const messageId = resolveOutboundMessageId(result);
      const contact = lookupWhatsAppContactMetadata({ accountId, jid });
      if (contact.phone || contact.name) {
        upsertWhatsAppHistoryContact(jid, contact.name, undefined, contact.phone);
      }
      upsertWhatsAppHistoryChat(jid, contact.name, jid.endsWith("@g.us"));
      insertWhatsAppHistoryMessage({
        id: messageId,
        chat_jid: jid,
        chat_name: contact.name,
        from_me: true,
        timestamp: Math.floor(Date.now() / 1000),
        message_type: mediaBuffer ? mediaType?.split("/")[0] ?? "media" : "text",
        text_content: text || undefined,
        caption: mediaBuffer ? text || undefined : undefined,
        raw_json: JSON.stringify({ payload, result }),
        source: "live",
      });
      return { messageId };
    },
    sendPoll: async (
      to: string,
      poll: { question: string; options: string[]; maxSelections?: number },
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      const result = await params.sock.sendMessage(jid, {
        poll: {
          name: poll.question,
          values: poll.options,
          selectableCount: poll.maxSelections ?? 1,
        },
      } as AnyMessageContent);
      recordWhatsAppOutbound(params.defaultAccountId);
      const messageId = resolveOutboundMessageId(result);
      return { messageId };
    },
    sendReaction: async (
      chatJid: string,
      messageId: string,
      emoji: string,
      fromMe: boolean,
      participant?: string,
    ): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await params.sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: jid,
            id: messageId,
            fromMe,
            participant: participant ? toWhatsappJid(participant) : undefined,
          },
        },
      } as AnyMessageContent);
    },
    sendComposingTo: async (to: string): Promise<void> => {
      const jid = toWhatsappJid(to);
      await params.sock.sendPresenceUpdate("composing", jid);
    },
  } as const;
}
