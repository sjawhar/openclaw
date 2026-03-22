import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeWhatsAppHistoryDb,
  insertWhatsAppHistoryMessage,
  searchWhatsAppHistory,
  upsertWhatsAppHistoryChat,
  upsertWhatsAppHistoryContact,
} from "./db.js";

describe("whatsapp history db", () => {
  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-history-"));
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    closeWhatsAppHistoryDb();
  });

  afterEach(async () => {
    closeWhatsAppHistoryDb();
    if (prevStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("searches messages by text, chat, sender, and fromMe", () => {
    upsertWhatsAppHistoryContact("111@s.whatsapp.net", "Jonathan", "Jonathan");
    upsertWhatsAppHistoryChat("111@s.whatsapp.net", "Jonathan", false);

    insertWhatsAppHistoryMessage({
      id: "m1",
      chat_jid: "111@s.whatsapp.net",
      chat_name: "Jonathan",
      sender_jid: "111@s.whatsapp.net",
      sender_name: "Jonathan",
      from_me: false,
      timestamp: 1_700_000_000,
      message_type: "text",
      text_content: "fusion reactor plans",
    });

    insertWhatsAppHistoryMessage({
      id: "m2",
      chat_jid: "111@s.whatsapp.net",
      chat_name: "Jonathan",
      from_me: true,
      timestamp: 1_700_000_100,
      message_type: "text",
      text_content: "my follow up",
    });

    expect(searchWhatsAppHistory({ query: "fusion" }).map((row) => row.id)).toEqual(["m1"]);
    expect(searchWhatsAppHistory({ chat: "Jonathan" }).map((row) => row.id)).toEqual(["m2", "m1"]);
    expect(searchWhatsAppHistory({ sender: "Jonathan" }).map((row) => row.id)).toEqual(["m1"]);
    expect(searchWhatsAppHistory({ fromMe: true }).map((row) => row.id)).toEqual(["m2"]);
  });
});
