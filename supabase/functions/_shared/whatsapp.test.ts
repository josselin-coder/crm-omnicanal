import { describe, expect, it } from "vitest";
import { BodyTooLarge, extractEvents, isMetaMediaUrl, readLimited, verifySignature } from "./whatsapp";

const now = Date.parse("2026-11-22T12:00:00Z");
const event = (value: object, account = "123") => ({
  object: "whatsapp_business_account",
  entry: [{ id: account, changes: [{ field: "messages", value }] }],
});

describe("WhatsApp webhook input", () => {
  it("verifies signatures over the original bytes and rejects tampering", async () => {
    const secret = "synthetic-unit-test-secret";
    const bytes = new TextEncoder().encode('{"value":"hola"}');
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const hash = await crypto.subtle.sign("HMAC", key, bytes);
    const header = "sha256=" + Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(await verifySignature(bytes, header, secret)).toBe(true);
    expect(await verifySignature(new TextEncoder().encode('{"value": "hola"}'), header, secret)).toBe(false);
    expect(await verifySignature(bytes, null, secret)).toBe(false);
    expect(await verifySignature(bytes, "sha256=broken", secret)).toBe(false);
  });

  it("accepts only events for the configured business account and phone", () => {
    const change = { metadata: { phone_number_id: "567" }, messages: [
      { id: "wamid.sample", from: "5112345678", timestamp: String(now / 1000), type: "text", text: { body: "Hola" } },
    ] };
    expect(extractEvents(event(change), "123", "567", now).messages).toHaveLength(1);
    expect(extractEvents(event(change, "999"), "123", "567", now).messages).toHaveLength(0);
    expect(extractEvents(event(change), "123", "999", now).messages).toHaveLength(0);
  });

  it("normalizes documents and delivery callbacks while ignoring invalid timestamps", () => {
    const requestId = "79db49a7-0744-4f78-afcd-83e05cb1afb6";
    const value = {
      metadata: { phone_number_id: "567" },
      contacts: [{ wa_id: "5112345678", profile: { name: "Cliente" } }],
      messages: [
        { id: "wamid.doc", from: "5112345678", timestamp: String(now / 1000), type: "document", document: { id: "42", filename: "../archivo.pdf" } },
        { id: "wamid.invalid", from: "5112345678", timestamp: "malformed", type: "text" },
      ],
      statuses: [{ id: "wamid.reply", status: "delivered", biz_opaque_callback_data: requestId }],
    };
    const parsed = extractEvents(event(value), "123", "567", now);
    expect(parsed.messages).toEqual([{
      id: "wamid.doc", sender: "5112345678", name: "Cliente", timestamp: new Date(now).toISOString(),
      kind: "document", body: "Archivo de WhatsApp", mediaId: "42", filename: ".._archivo.pdf",
    }]);
    expect(parsed.deliveries).toEqual([{ id: "wamid.reply", requestId, status: "delivered" }]);
  });

  it("limits streamed bodies and refuses media URLs outside Meta", async () => {
    await expect(readLimited(new Response("safe").body, 4)).resolves.toEqual(new TextEncoder().encode("safe"));
    await expect(readLimited(new Response("oversize").body, 4)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(isMetaMediaUrl("https://lookaside.fbsbx.com/whatsapp_business/attachments/?id=42")).toBe(true);
    expect(isMetaMediaUrl("https://lookaside.fbsbx.com.example.com/file")).toBe(false);
    expect(isMetaMediaUrl("https://lookaside.fbsbx.com@evil.example/file")).toBe(false);
    expect(isMetaMediaUrl("http://lookaside.fbsbx.com/file")).toBe(false);
  });
});
