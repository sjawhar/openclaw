import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export type StoredContact = {
  id: string;
  name?: string;
  notify?: string;
  phone?: string;
};

const CONTACTS_FILE = "contacts.json";

export function readContactStore(authDir: string): Record<string, StoredContact> {
  try {
    const filePath = join(authDir, CONTACTS_FILE);
    const data = readFileSync(filePath, "utf8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export function writeContactStore(authDir: string, contacts: Record<string, StoredContact>): void {
  const filePath = join(authDir, CONTACTS_FILE);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(contacts, null, 2), "utf8");
}

export function mergeContacts(
  existing: Record<string, StoredContact>,
  incoming: Array<{ id: string; name?: string; notify?: string }>,
): Record<string, StoredContact> {
  const merged = { ...existing };
  for (const contact of incoming) {
    if (!contact.id) continue;
    const id = contact.id;
    const phone = id.replace(/@s\.whatsapp\.net$/, "");
    merged[id] = {
      ...merged[id],
      id,
      phone,
      ...(contact.name ? { name: contact.name } : {}),
      ...(contact.notify ? { notify: contact.notify } : {}),
    };
  }
  return merged;
}
