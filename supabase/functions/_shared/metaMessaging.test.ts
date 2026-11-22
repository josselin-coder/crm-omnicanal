import { describe, expect, it } from "vitest";
import { isMetaAttachmentUrl, metaEvents, metaProviderKey, metaSendPayload, metaWebhookChannel } from "./metaMessaging";
import { verifySignature } from "./whatsapp";

const now = Date.parse("2026-11-22T12:00:00Z");
const entry = (kind: string, event: object, account = "123") => ({
  object: kind,
  entry: [{ id: account, messaging: [event] }],
});

const incoming = {
  sender: { id: "456" },
  recipient: { id: "123" },
  timestamp: now,
  message: {
    mid: "m_reference",
    text: "Necesito 12 piezas",
    attachments: [
      { type: "image", payload: { url: "https://cdn.example.fbcdn.net/image.png" } },
      { type: "file", payload: { url: "https://lookaside.fbsbx.com/download", filename: "plano.dxf" } },
    ],
  },
};

describe("Meta messaging contracts", () => {
  it("identifies both accounts and rejects an event for a different configured recipient", () => {
    expect(metaWebhookChannel(entry("page", incoming))).toBe("messenger");
    expect(metaWebhookChannel(entry("instagram", incoming))).toBe("instagram");
    expect(metaEvents(entry("instagram", incoming), "instagram", "999", now)).toEqual([]);
    expect(metaEvents(entry("page", incoming), "instagram", "123", now)).toEqual([]);
    expect(metaEvents(entry("page", { ...incoming, recipient: { id: "999" } }), "messenger", "123", now)).toEqual([]);
  });

  it("normalizes multiple files and namespaces provider IDs across channels", () => {
    const events = metaEvents(entry("instagram", incoming), "instagram", "123", now);
    expect(events).toMatchObject([{
      type: "message", id: "m_reference", peer: "456", text: "Necesito 12 piezas",
      attachments: [
        { kind: "image", url: "https://cdn.example.fbcdn.net/image.png" },
        { kind: "document", name: "plano.dxf" },
      ],
    }]);
    expect(metaProviderKey("instagram", "123", "m_reference"))
      .not.toBe(metaProviderKey("messenger", "123", "m_reference"));
  });

  it("handles Instagram field/value webhook payloads", () => {
    const payload = { object: "instagram", entry: [{ id: "123", changes: [{ field: "messages", value: incoming }] }] };
    expect(metaEvents(payload, "instagram", "123", now)).toHaveLength(1);
  });

  it("does not treat echoes as inbound customer intent", () => {
    const nonce = "921c5434-9bc4-4ac2-bd18-0cc6a315e23a";
    const echo = {
      ...incoming, sender: { id: "123" }, recipient: { id: "456" },
      message: { mid: "m_reply", is_echo: true, metadata: nonce },
    };
    expect(metaEvents(entry("page", echo), "messenger", "123", now)).toEqual([
      { type: "receipt", ids: ["m_reply"], peer: "456", request: nonce, through: null, status: "sent" },
    ]);
  });

  it("parses a Messenger watermark and an Instagram exact read receipt", () => {
    const messenger = { sender: incoming.sender, recipient: incoming.recipient, read: { watermark: now } };
    const instagram = { ...messenger, read: { mid: "m_reply" } };
    expect(metaEvents(entry("page", messenger), "messenger", "123", now)).toMatchObject([
      { status: "read", through: new Date(now).toISOString(), ids: [] },
    ]);
    expect(metaEvents(entry("instagram", instagram), "instagram", "123", now)).toMatchObject([
      { status: "read", through: null, ids: ["m_reply"] },
    ]);
  });

  it("uses the appropriate manual reply payload without special messaging tags", () => {
    expect(metaSendPayload("instagram", "456", "Hola", "request")).toEqual({
      recipient: { id: "456" }, message: { text: "Hola" },
    });
    expect(metaSendPayload("messenger", "456", "Hola", "request")).toEqual({
      recipient: { id: "456" }, messaging_type: "RESPONSE", message: { text: "Hola", metadata: "request" },
    });
  });

  it("permits only HTTPS Meta attachment hosts and records unknown links as unavailable", () => {
    expect(isMetaAttachmentUrl("https://scontent.cdninstagram.com/photo")).toBe(true);
    for (const url of [
      "http://scontent.cdninstagram.com/photo", "https://cdninstagram.com.evil.test/file",
      "https://cdninstagram.com@evil.test/file", "https://127.0.0.1/file",
      "https://fbcdn.net:444/file",
    ]) expect(isMetaAttachmentUrl(url)).toBe(false);

    const malformed = {
      ...incoming, message: { mid: "m_unknown", attachments: [{ type: "image", payload: { url: "https://evil.test/file" } }] },
    };
    expect(metaEvents(entry("page", malformed), "messenger", "123", now)).toMatchObject([
      { type: "message", attachments: [{ url: null }] },
    ]);
  });

  it("rejects tampered payloads and signatures for a different Meta app", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(entry("page", incoming)));
    const testSecret = "synthetic-app-secret";
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(testSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, bytes);
    const signature = "sha256=" + Array.from(new Uint8Array(mac), (value) => value.toString(16).padStart(2, "0")).join("");
    expect(await verifySignature(bytes, signature, testSecret)).toBe(true);
    expect(await verifySignature(bytes, signature, "different-app")).toBe(false);
    bytes[0] = 0;
    expect(await verifySignature(bytes, signature, testSecret)).toBe(false);
  });
});
