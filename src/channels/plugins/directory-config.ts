import type { OpenClawConfig } from "../../config/types.js";
import { inspectDiscordAccount } from "../../discord/account-inspect.js";
import { mapAllowFromEntries } from "../../plugin-sdk/channel-config-helpers.js";
import { inspectSlackAccount } from "../../slack/account-inspect.js";
import { inspectTelegramAccount } from "../../telegram/account-inspect.js";
import { resolveWhatsAppAccount } from "../../web/accounts.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "../../whatsapp/normalize.js";
import { applyDirectoryQueryAndLimit, toDirectoryEntries } from "./directory-config-helpers.js";
import { normalizeSlackMessagingTarget } from "./normalize/slack.js";
import type { ChannelDirectoryEntry } from "./types.js";

export type DirectoryConfigParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
};

function addAllowFromAndDmsIds(
  ids: Set<string>,
  allowFrom: readonly unknown[] | undefined,
  dms: Record<string, unknown> | undefined,
) {
  for (const entry of allowFrom ?? []) {
    const raw = String(entry).trim();
    if (!raw || raw === "*") {
      continue;
    }
    ids.add(raw);
  }
  addTrimmedEntries(ids, Object.keys(dms ?? {}));
}

function addTrimmedId(ids: Set<string>, value: unknown) {
  const trimmed = String(value).trim();
  if (trimmed) {
    ids.add(trimmed);
  }
}

function addTrimmedEntries(ids: Set<string>, values: Iterable<unknown>) {
  for (const value of values) {
    addTrimmedId(ids, value);
  }
}

function normalizeTrimmedSet(
  ids: Set<string>,
  normalize: (raw: string) => string | null,
): string[] {
  return Array.from(ids)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => normalize(raw))
    .filter((id): id is string => Boolean(id));
}

export async function listSlackDirectoryPeersFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = inspectSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const ids = new Set<string>();

  addAllowFromAndDmsIds(ids, account.config.allowFrom ?? account.dm?.allowFrom, account.config.dms);
  for (const channel of Object.values(account.config.channels ?? {})) {
    addTrimmedEntries(ids, channel.users ?? []);
  }

  const normalizedIds = normalizeTrimmedSet(ids, (raw) => {
    const mention = raw.match(/^<@([A-Z0-9]+)>$/i);
    const normalizedUserId = (mention?.[1] ?? raw).replace(/^(slack|user):/i, "").trim();
    if (!normalizedUserId) {
      return null;
    }
    const target = `user:${normalizedUserId}`;
    return normalizeSlackMessagingTarget(target) ?? target.toLowerCase();
  }).filter((id) => id.startsWith("user:"));
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(normalizedIds, params));
}

export async function listSlackDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = inspectSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const ids = Object.keys(account.config.channels ?? {})
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => normalizeSlackMessagingTarget(raw) ?? raw.toLowerCase())
    .filter((id) => id.startsWith("channel:"));
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(ids, params));
}

export async function listDiscordDirectoryPeersFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = inspectDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  const ids = new Set<string>();

  addAllowFromAndDmsIds(
    ids,
    account.config.allowFrom ?? account.config.dm?.allowFrom,
    account.config.dms,
  );
  for (const guild of Object.values(account.config.guilds ?? {})) {
    addTrimmedEntries(ids, guild.users ?? []);
    for (const channel of Object.values(guild.channels ?? {})) {
      addTrimmedEntries(ids, channel.users ?? []);
    }
  }

  const normalizedIds = normalizeTrimmedSet(ids, (raw) => {
    const mention = raw.match(/^<@!?(\d+)>$/);
    const cleaned = (mention?.[1] ?? raw).replace(/^(discord|user):/i, "").trim();
    if (!/^\d+$/.test(cleaned)) {
      return null;
    }
    return `user:${cleaned}`;
  });
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(normalizedIds, params));
}

export async function listDiscordDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = inspectDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  const ids = new Set<string>();
  for (const guild of Object.values(account.config.guilds ?? {})) {
    addTrimmedEntries(ids, Object.keys(guild.channels ?? {}));
  }

  const normalizedIds = normalizeTrimmedSet(ids, (raw) => {
    const mention = raw.match(/^<#(\d+)>$/);
    const cleaned = (mention?.[1] ?? raw).replace(/^(discord|channel|group):/i, "").trim();
    if (!/^\d+$/.test(cleaned)) {
      return null;
    }
    return `channel:${cleaned}`;
  });
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(normalizedIds, params));
}

export async function listTelegramDirectoryPeersFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = inspectTelegramAccount({ cfg: params.cfg, accountId: params.accountId });
  const raw = [
    ...mapAllowFromEntries(account.config.allowFrom),
    ...Object.keys(account.config.dms ?? {}),
  ];
  const ids = Array.from(
    new Set(
      raw
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(telegram|tg):/i, "")),
    ),
  )
    .map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) {
        return null;
      }
      if (/^-?\d+$/.test(trimmed)) {
        return trimmed;
      }
      const withAt = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
      return withAt;
    })
    .filter((id): id is string => Boolean(id));
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(ids, params));
}

export async function listTelegramDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = inspectTelegramAccount({ cfg: params.cfg, accountId: params.accountId });
  const ids = Object.keys(account.config.groups ?? {})
    .map((id) => id.trim())
    .filter((id) => Boolean(id) && id !== "*");
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(ids, params));
}

export async function listWhatsAppDirectoryPeersFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });
  const configIds = (account.allowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter((entry) => Boolean(entry) && entry !== "*")
    .map((entry) => normalizeWhatsAppTarget(entry) ?? "")
    .filter(Boolean)
    .filter((id) => !isWhatsAppGroupJid(id));

  const configEntries = toDirectoryEntries("user", applyDirectoryQueryAndLimit(configIds, params));

  let storeEntries: ChannelDirectoryEntry[] = [];
  if (account.authDir) {
    try {
      const { readContactStore } = await import("../../web/contacts-store.js");
      const contacts = readContactStore(account.authDir);
      const contactEntries: ChannelDirectoryEntry[] = [];
      for (const contact of Object.values(contacts)) {
        const normalized = normalizeWhatsAppTarget(contact.phone ?? contact.id);
        if (!normalized || isWhatsAppGroupJid(normalized)) {
          continue;
        }
        contactEntries.push({
          kind: "user",
          id: normalized,
          name: contact.name || contact.notify || undefined,
        });
      }

      if (params.query) {
        const q = params.query.toLowerCase();
        storeEntries = contactEntries.filter(
          (entry) => entry.id.includes(q) || entry.name?.toLowerCase().includes(q),
        );
      } else {
        storeEntries = contactEntries;
      }
    } catch {}
  }

  const seenIds = new Set(configEntries.map((entry) => entry.id));
  const merged = [...configEntries];
  for (const entry of storeEntries) {
    if (seenIds.has(entry.id)) {
      continue;
    }
    merged.push(entry);
    seenIds.add(entry.id);
  }

  const limit = params.limit ?? null;
  if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) {
    return merged.slice(0, limit);
  }
  return merged;
}

export async function listWhatsAppDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });
  const ids = Object.keys(account.groups ?? {})
    .map((id) => id.trim())
    .filter((id) => Boolean(id) && id !== "*");
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(ids, params));
}
