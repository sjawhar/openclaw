import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { searchWhatsAppHistory } from "../../../src/whatsapp-history/db.js";
import { resolveAuthorizedWhatsAppOutboundTarget } from "./action-runtime-target-auth.js";
import {
  createActionGate,
  jsonResult,
  readReactionParams,
  readStringParam,
  type OpenClawConfig,
} from "./runtime-api.js";
import { sendReactionWhatsApp } from "./send.js";

export const whatsAppActionRuntime = {
  resolveAuthorizedWhatsAppOutboundTarget,
  searchWhatsAppHistory,
  sendReactionWhatsApp,
};

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseDateToUnixSeconds(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

function formatHistoryTimestamp(value: number): string {
  return new Date(value * 1000).toISOString();
}

export async function handleWhatsAppAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const isActionEnabled = createActionGate(cfg.channels?.whatsapp?.actions);

  if (action === "react") {
    if (!isActionEnabled("reactions")) {
      throw new Error("WhatsApp reactions are disabled.");
    }
    const chatJid = readStringParam(params, "chatJid", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    const { emoji, remove, isEmpty } = readReactionParams(params, {
      removeErrorMessage: "Emoji is required to remove a WhatsApp reaction.",
    });
    const participant = readStringParam(params, "participant");
    const accountId = readStringParam(params, "accountId");
    const fromMeRaw = params.fromMe;
    const fromMe = typeof fromMeRaw === "boolean" ? fromMeRaw : undefined;

    // Resolve account + allowFrom via shared account logic so auth and routing stay aligned.
    const resolved = whatsAppActionRuntime.resolveAuthorizedWhatsAppOutboundTarget({
      cfg,
      chatJid,
      accountId,
      actionLabel: "reaction",
    });

    const resolvedEmoji = remove ? "" : emoji;
    await whatsAppActionRuntime.sendReactionWhatsApp(resolved.to, messageId, resolvedEmoji, {
      verbose: false,
      fromMe,
      participant: participant ?? undefined,
      accountId: resolved.accountId,
    });
    if (!remove && !isEmpty) {
      return jsonResult({ ok: true, added: emoji });
    }
    return jsonResult({ ok: true, removed: true });
  }

  if (action === "search") {
    const query = readStringParam(params, "query");
    const chat = readStringParam(params, "chat");
    const sender = readStringParam(params, "sender");
    const fromMe = readOptionalBoolean(params.fromMe);
    const since = parseDateToUnixSeconds(readStringParam(params, "since"));
    const until = parseDateToUnixSeconds(readStringParam(params, "until"));
    const limit = readOptionalNumber(params.limit) ?? 50;
    const results = whatsAppActionRuntime.searchWhatsAppHistory({
      query,
      chat,
      sender,
      fromMe,
      since,
      until,
      limit,
    });
    return jsonResult({
      ok: true,
      results: {
        messages: results.map((row) => ({
          messageId: row.id,
          authorTag: row.from_me
            ? "me"
            : row.sender_name || row.sender_pushname || row.sender_jid || "unknown",
          timestamp: formatHistoryTimestamp(row.timestamp),
          content: row.text_content || row.caption || "",
          chat: row.chat_name || row.chat_jid,
          type: row.message_type,
        })),
      },
    });
  }

  throw new Error(`Unsupported WhatsApp action: ${action}`);
}
