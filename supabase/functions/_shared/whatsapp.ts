const phonePattern = /^\d{1,32}$/;
const userIdPattern = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/;
const providerPattern = /^wamid\.[A-Za-z0-9._+=/-]{1,500}$/;
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const mediaLimit = 20 * 1024 * 1024;

const mediaKinds = ["image", "document", "audio", "video", "sticker"] as const;
type MediaKind = (typeof mediaKinds)[number];

export type Incoming = {
  id: string;
  sender: string | null;
  userId: string | null;
  name: string;
  timestamp: string;
  kind: "text" | MediaKind | "unsupported";
  body: string;
  mediaId?: string;
  filename?: string;
};

type IdentityChange = {
  previous: string;
  next: string;
  phone: string | null;
};

export function whatsappDestination(identifier: string) {
  return phonePattern.test(identifier)
    ? { to: identifier }
    : { recipient: identifier };
}

export type Delivery = {
  id: string;
  requestId: string | null;
  status: "sent" | "delivered" | "read" | "failed";
};

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function verifySignature(
  bytes: Uint8Array<ArrayBuffer>,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  const match = signature?.match(/^sha256=([a-f0-9]{64})$/i);
  if (!match) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const expected = Uint8Array.from(match[1].match(/.{2}/g) ?? [], (part) =>
    Number.parseInt(part, 16),
  );
  return crypto.subtle.verify("HMAC", key, expected, bytes);
}

export class BodyTooLarge extends Error {}

export async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function extractEvents(
  input: unknown,
  accountId: string,
  phoneId: string,
  now = Date.now(),
): {
  messages: Incoming[];
  deliveries: Delivery[];
  identityChanges: IdentityChange[];
} {
  const messages: Incoming[] = [];
  const deliveries: Delivery[] = [];
  const identityChanges: IdentityChange[] = [];
  const root = object(input);
  if (root.object !== "whatsapp_business_account")
    return { messages, deliveries, identityChanges };

  for (const rawEntry of array(root.entry)) {
    const entry = object(rawEntry);
    if (entry.id !== accountId) continue;
    for (const rawChange of array(entry.changes)) {
      const change = object(rawChange);
      const value = object(change.value);
      if (
        change.field !== "messages" ||
        object(value.metadata).phone_number_id !== phoneId
      )
        continue;
      const contacts = array(value.contacts).map(object);
      for (const rawMessage of array(value.messages)) {
        const message = object(rawMessage);
        const id = string(message.id);
        if (message.type === "system") {
          const system = object(message.system);
          const previous = string(system.previous_user_id);
          const next = string(system.user_id);
          const phone = string(system.wa_id);
          if (
            (system.type === "user_changed_number" ||
              system.type === "user_changed_user_id") &&
            userIdPattern.test(previous) &&
            userIdPattern.test(next) &&
            previous !== next
          ) {
            identityChanges.push({
              previous,
              next,
              phone: phonePattern.test(phone) ? phone : null,
            });
          }
          continue;
        }
        const from = string(message.from);
        const fromUser = string(message.from_user_id);
        const sender = phonePattern.test(from) ? from : null;
        const userId = userIdPattern.test(fromUser) ? fromUser : null;
        const seconds = string(message.timestamp);
        const milliseconds = Number(seconds) * 1000;
        if (
          !providerPattern.test(id) ||
          (!sender && !userId) ||
          !/^\d{1,12}$/.test(seconds) ||
          milliseconds <= 0 ||
          milliseconds > now + 5 * 60 * 1000
        )
          continue;
        const type = string(message.type);
        const mediaKind = mediaKinds.find((kind) => kind === type);
        const media = mediaKind ? object(message[mediaKind]) : {};
        const profile = object(
          contacts.find(
            (contact) =>
              (userId && contact.user_id === userId) ||
              (sender && contact.wa_id === sender),
          )?.profile,
        );
        const name = string(profile.name) || string(profile.username);
        const text = string(object(message.text).body).trim();
        const caption = string(media.caption).trim();
        const mediaId = string(media.id);
        messages.push({
          id,
          sender,
          userId,
          name,
          timestamp: new Date(Math.min(now, milliseconds)).toISOString(),
          kind: mediaKind ?? (type === "text" && text ? "text" : "unsupported"),
          body: (mediaKind
            ? caption || "Archivo de WhatsApp"
            : type === "text" && text
              ? text
              : "Mensaje de WhatsApp no compatible"
          ).slice(0, 4096),
          mediaId:
            mediaKind && phonePattern.test(mediaId) ? mediaId : undefined,
          filename: sanitizeFilename(string(media.filename)),
        });
      }
      for (const rawStatus of array(value.statuses)) {
        const status = object(rawStatus);
        const id = string(status.id);
        const requestId = string(status.biz_opaque_callback_data);
        const delivery = status.status;
        if (
          providerPattern.test(id) &&
          (delivery === "sent" ||
            delivery === "delivered" ||
            delivery === "read" ||
            delivery === "failed")
        ) {
          deliveries.push({
            id,
            requestId: uuidPattern.test(requestId) ? requestId : null,
            status: delivery,
          });
        }
      }
    }
  }

  return { messages, deliveries, identityChanges };
}

function sanitizeFilename(value: string) {
  const safe = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    if (character === "/" || character === "\\" || code < 32 || code === 127) {
      return "_";
    }
    return character;
  }).join("");
  return safe.trim().slice(0, 160) || undefined;
}

export function isMetaMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "lookaside.fbsbx.com" &&
      !url.port &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function cloudSettings() {
  const phoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
  const apiVersion = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "";
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  return phonePattern.test(phoneId) &&
    /^v\d{1,3}\.\d{1,2}$/.test(apiVersion) &&
    token
    ? { phoneId, token, base: `https://graph.facebook.com/${apiVersion}` }
    : null;
}
