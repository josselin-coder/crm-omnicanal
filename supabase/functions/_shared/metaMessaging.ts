import { object, string } from "./whatsapp.ts";

export type MetaChannel = "instagram" | "messenger";
const identifier = /^\d{1,32}$/;
const externalId = /^[A-Za-z0-9._:/+=-]{1,512}$/;
const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowedMediaDomains = ["fbcdn.net", "cdninstagram.com", "fbsbx.com"];

export const metaMediaLimit = 20 * 1024 * 1024;

type Asset = { name: string; kind: string; url: string | null };
export type MetaEvent =
  | { type: "message"; id: string; peer: string; timestamp: string; text: string; attachments: Asset[] }
  | { type: "receipt"; peer: string; ids: string[]; through: string | null; request: string | null; status: "sent" | "delivered" | "read" };

const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function metaChannel(value: unknown): MetaChannel | null {
  return value === "instagram" || value === "messenger" ? value : null;
}

export function metaWebhookChannel(payload: unknown): MetaChannel | null {
  const kind = object(payload).object;
  return kind === "instagram" ? "instagram" : kind === "page" ? "messenger" : null;
}

export function metaSettings(channel: MetaChannel) {
  if (Deno.env.get("META_MESSAGING_ENABLED") !== "true") return null;
  const prefix = channel === "instagram" ? "META_INSTAGRAM" : "META_MESSENGER";
  const account = Deno.env.get(`${prefix}_ACCOUNT_ID`) ?? "";
  const secret = Deno.env.get(`${prefix}_APP_SECRET`) ?? "";
  const token = Deno.env.get(`${prefix}_ACCESS_TOKEN`) ?? "";
  const version = Deno.env.get("META_MESSAGING_GRAPH_VERSION") ?? "";
  if (!identifier.test(account) || !/^v\d{1,3}\.\d{1,2}$/.test(version) || !secret || !token) return null;
  const host = channel === "instagram" ? "graph.instagram.com" : "graph.facebook.com";
  return { channel, account, secret, token, base: `https://${host}/${version}` };
}

export function signatureAccounts() {
  return (["instagram", "messenger"] as const).flatMap((channel) => {
    const settings = metaSettings(channel);
    return settings ? [settings] : [];
  });
}

export function metaSendPayload(channel: MetaChannel, to: string, text: string, id: string) {
  return {
    recipient: { id: to },
    ...(channel === "messenger" ? { messaging_type: "RESPONSE" } : {}),
    message: { text, ...(channel === "messenger" ? { metadata: id } : {}) },
  };
}

export function metaProviderKey(channel: MetaChannel, account: string, id: string) {
  return `${channel}:${account}:${id}`;
}

export function providerMessageId(value: unknown) {
  const id = string(value);
  return externalId.test(id) ? id : null;
}

export function isMetaAttachmentUrl(value: string): boolean {
  if (value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.username && !url.password &&
      allowedMediaDomains.some((domain) => url.hostname === domain || url.hostname.endsWith("." + domain));
  } catch {
    return false;
  }
}

function when(value: unknown, now: number): string | null {
  const stamp = Number(value);
  if (!Number.isFinite(stamp) || stamp <= 0 || stamp > now + 5 * 60_000) return null;
  return new Date(Math.min(stamp, now)).toISOString();
}

function assets(value: unknown): Asset[] {
  return array(value).slice(0, 8).map((raw, index) => {
    const asset = object(raw);
    const kind = string(asset.type);
    const detail = object(asset.payload);
    const url = string(detail.url);
    const name = Array.from(string(detail.filename) || string(detail.name) || string(detail.title), (character) => {
      const code = character.charCodeAt(0);
      return character === "/" || character === "\\" || code < 32 || code === 127 ? "_" : character;
    }).join("").trim().slice(0, 160);
    const supported = ["image", "file", "audio", "video", "sticker", "ig_post", "ig_reel", "reel", "share"];
    return {
      name: name || `Adjunto ${index + 1}`,
      kind: supported.includes(kind) ? kind === "file" ? "document" : kind : "unsupported",
      url: supported.includes(kind) && isMetaAttachmentUrl(url) ? url : null,
    };
  });
}

export function metaEvents(
  payload: unknown,
  channel: MetaChannel,
  account: string,
  now = Date.now(),
): MetaEvent[] {
  if (metaWebhookChannel(payload) !== channel) return [];
  const events: MetaEvent[] = [];
  for (const raw of array(object(payload).entry)) {
    const entry = object(raw);
    if (entry.id !== account) continue;
    // Meta documents both messaging entries and field/value webhook examples.
    const changes = array(entry.changes).flatMap((rawChange) => {
      const change = object(rawChange);
      return ["messages", "message_echoes", "messaging_seen", "message_reads", "message_deliveries"].includes(string(change.field))
        ? [change.value]
        : [];
    });
    for (const rawEvent of [...array(entry.messaging), ...changes]) {
      const event = object(rawEvent);
      const sender = string(object(event.sender).id);
      const recipient = string(object(event.recipient).id);
      const message = object(event.message);
      const id = providerMessageId(message.mid);
      const timestamp = when(event.timestamp, now);
      if (sender === account && identifier.test(recipient) && id && (message.is_echo || message.is_self)) {
        const metadata = string(message.metadata);
        events.push({ type: "receipt", peer: recipient, ids: [id], request: requestId.test(metadata) ? metadata : null, through: null, status: "sent" });
        continue;
      }
      if (recipient !== account || !identifier.test(sender) || sender === account) continue;
      if (id && timestamp && !message.is_echo && !message.is_self && !message.is_deleted) {
        const attachments = assets(message.attachments);
        const text = string(message.text).trim().slice(0, 4096);
        if (text || attachments.length || message.is_unsupported) {
          events.push({ type: "message", id, peer: sender, timestamp, text: text || (attachments.length ? "Adjunto de Meta" : "Mensaje no compatible"), attachments });
        }
      }
      const read = object(event.read);
      const readId = providerMessageId(read.mid);
      const readThrough = channel === "messenger" ? when(read.watermark, now) : null;
      if (readId || readThrough) {
        events.push({ type: "receipt", peer: sender, ids: readId ? [readId] : [], request: null, through: readThrough, status: "read" });
      }
      if (channel === "messenger") {
        const delivery = object(event.delivery);
        const ids = array(delivery.mids).map(providerMessageId).filter((mid) => mid !== null);
        const through = when(delivery.watermark, now);
        if (ids.length || through) {
          events.push({ type: "receipt", peer: sender, ids, request: null, through, status: "delivered" });
        }
      }
    }
  }
  return events;
}
