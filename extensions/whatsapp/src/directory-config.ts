import {
  listResolvedDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryUserEntriesFromAllowFrom,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { readContactStore } from "../../../src/web/contacts-store.js";
import { resolveWhatsAppAccount } from "./accounts.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";

type DirectoryUserEntry = {
  kind: "user";
  id: string;
  name: string | undefined;
};

export async function listWhatsAppDirectoryPeersFromConfig(params: DirectoryConfigParams) {
  const configEntries = await listResolvedDirectoryUserEntriesFromAllowFrom({
    ...params,
    resolveAccount: (cfg, accountId) => resolveWhatsAppAccount({ cfg, accountId }),
    resolveAllowFrom: (account) => account.allowFrom,
    normalizeId: (entry) => {
      const normalized = normalizeWhatsAppTarget(entry);
      if (!normalized || isWhatsAppGroupJid(normalized)) {
        return null;
      }
      return normalized;
    },
  });

  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });
  const contacts = readContactStore(account.authDir);
  const query = params.query?.trim().toLowerCase();
  const storeEntries = Object.values(contacts)
    .map((contact): DirectoryUserEntry | null => {
      const normalized = normalizeWhatsAppTarget(contact.phone ?? contact.id);
      if (!normalized || isWhatsAppGroupJid(normalized)) {
        return null;
      }
      return {
        kind: "user" as const,
        id: normalized,
        name: contact.name || contact.notify || undefined,
      };
    })
    .filter((entry): entry is DirectoryUserEntry => entry !== null)
    .filter((entry) => {
      if (!query) {
        return true;
      }
      return (
        entry.id.toLowerCase().includes(query) ||
        entry.name?.toLowerCase().includes(query) === true
      );
    });

  const merged = [...configEntries];
  const seen = new Set(configEntries.map((entry) => entry.id));
  for (const entry of storeEntries) {
    if (seen.has(entry.id)) {
      continue;
    }
    merged.push(entry);
    seen.add(entry.id);
  }

  const limit = params.limit ?? null;
  if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) {
    return merged.slice(0, limit);
  }
  return merged;
}

export async function listWhatsAppDirectoryGroupsFromConfig(params: DirectoryConfigParams) {
  return listResolvedDirectoryGroupEntriesFromMapKeys({
    ...params,
    resolveAccount: (cfg, accountId) => resolveWhatsAppAccount({ cfg, accountId }),
    resolveGroups: (account) => account.groups,
  });
}
