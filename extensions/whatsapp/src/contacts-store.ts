import fs from "node:fs";
import path from "node:path";

export type StoredContact = {
  id: string;
  name?: string;
  notify?: string;
  phone?: string;
};

const CONTACTS_FILE = "contacts.json";

export function readContactStore(authDir: string): Record<string, StoredContact> {
  try {
    const filePath = path.join(authDir, CONTACTS_FILE);
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

export function writeContactStore(
  authDir: string,
  contacts: Record<string, StoredContact>,
): void {
  const filePath = path.join(authDir, CONTACTS_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(contacts, null, 2), "utf8");
}

export function mergeContacts(
  existing: Record<string, StoredContact>,
  incoming: Array<{ id: string; name?: string; notify?: string }>,
): Record<string, StoredContact> {
  const merged = { ...existing };
  for (const contact of incoming) {
    const id = contact.id;
    const phone = id.endsWith("@s.whatsapp.net")
      ? id.slice(0, -"@s.whatsapp.net".length)
      : undefined;
    merged[id] = {
      ...merged[id],
      id,
      phone: phone ?? merged[id]?.phone,
      ...(contact.name ? { name: contact.name } : {}),
      ...(contact.notify ? { notify: contact.notify } : {}),
    };
  }
  return merged;
}
