import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  observeConversation,
  queueObservation,
} from "../_shared/assistantObserver.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import {
  BodyTooLarge,
  cloudSettings,
  extractEvents,
  isMetaMediaUrl,
  mediaLimit,
  object,
  readLimited,
  string,
  verifySignature,
  type Incoming,
} from "../_shared/whatsapp.ts";

const bucket = "whatsapp-media";
const requestLimit = 1024 * 1024;

async function saveMedia(
  message: Incoming,
  settings: NonNullable<ReturnType<typeof cloudSettings>>,
) {
  if (!message.mediaId) return null;
  const headers = { Authorization: `Bearer ${settings.token}` };
  const metadata = await fetch(
    `${settings.base}/${message.mediaId}?phone_number_id=${settings.phoneId}`,
    { headers, redirect: "error", signal: AbortSignal.timeout(8000) },
  );
  if (metadata.status === 404 || metadata.status === 410) return null;
  if (!metadata.ok) throw new Error("Media metadata unavailable");

  const data = object(await metadata.json());
  const url = string(data.url);
  if (!isMetaMediaUrl(url)) throw new Error("Unexpected media URL");
  if (Number(data.file_size) > mediaLimit) return null;

  const file = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(12000),
  });
  if (file.status === 404 || file.status === 410) return null;
  if (!file.ok) throw new Error("Media download unavailable");
  if (Number(file.headers.get("content-length")) > mediaLimit) {
    await file.body?.cancel();
    return null;
  }

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readLimited(file.body, mediaLimit);
  } catch (error) {
    if (error instanceof BodyTooLarge) return null;
    throw error;
  }
  if (!bytes.length) return null;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message.id)),
  );
  const objectId = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const path = `${settings.phoneId}/${objectId}`;
  const mime = string(data.mime_type);
  const safeMime = /^[\w.+-]+\/[\w.+-]+$/.test(mime)
    ? mime
    : "application/octet-stream";
  const extensions: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "video/mp4": ".mp4",
    "audio/ogg": ".ogg",
  };
  const extension = extensions[safeMime] ?? "";
  const { error } = await supabaseAdmin.storage
    .from(bucket)
    .upload(path, bytes, {
      contentType: safeMime,
      upsert: true,
    });
  if (error) throw new Error("Private media upload failed");

  return {
    path,
    name: message.filename ?? `whatsapp-${objectId.slice(0, 8)}${extension}`,
    mime: safeMime,
  };
}

async function receive(req: Request) {
  const appSecret = Deno.env.get("WHATSAPP_APP_SECRET");
  const accountId = Deno.env.get("WHATSAPP_WABA_ID");
  const settings = cloudSettings();
  if (!appSecret || !accountId || !/^\d{1,32}$/.test(accountId) || !settings) {
    return new Response(null, { status: 503 });
  }

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readLimited(req.body, requestLimit);
  } catch (error) {
    if (error instanceof BodyTooLarge)
      return new Response(null, { status: 413 });
    throw error;
  }
  if (
    !(await verifySignature(
      bytes,
      req.headers.get("x-hub-signature-256"),
      appSecret,
    ))
  ) {
    return new Response(null, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return new Response(null, { status: 400 });
  }

  const { messages, deliveries, identityChanges } = extractEvents(
    payload,
    accountId,
    settings.phoneId,
  );
  for (const change of identityChanges) {
    const { error } = await supabaseAdmin.rpc("rotate_whatsapp_identity", {
      phone_id: settings.phoneId,
      previous_user_id: change.previous,
      next_user_id: change.next,
      next_phone: change.phone,
    });
    if (error)
      throw new Error("WhatsApp contact identity could not be updated");
  }

  const touched = new Set<string>();
  for (const message of messages) {
    const { data: existing, error: findError } = await supabaseAdmin
      .from("inbox_messages")
      .select("conversation_id")
      .eq("provider_message_id", message.id)
      .maybeSingle();
    if (findError) throw new Error("Message lookup failed");
    if (existing) {
      touched.add(existing.conversation_id);
      continue;
    }

    const media = await saveMedia(message, settings);
    const { error } = await supabaseAdmin.rpc("receive_whatsapp_message", {
      phone_id: settings.phoneId,
      sender: message.sender,
      sender_user_id: message.userId,
      sender_name: message.name,
      provider_id: message.id,
      received_at: message.timestamp,
      message_body:
        !media && message.kind !== "text" && message.kind !== "unsupported"
          ? `${message.body}\nAdjunto no disponible o superior a 20 MB.`
          : message.body,
      kind: message.kind,
      media_path: media?.path ?? null,
      media_name: media?.name ?? null,
      media_mime: media?.mime ?? null,
    });
    if (error) throw new Error("Message could not be recorded");

    const { data: saved, error: savedError } = await supabaseAdmin
      .from("inbox_messages")
      .select("conversation_id")
      .eq("provider_message_id", message.id)
      .single();
    if (savedError)
      throw new Error("Could not locate the inbound conversation");
    touched.add(saved.conversation_id);
  }

  for (const delivery of deliveries) {
    const { error } = await supabaseAdmin.rpc("update_whatsapp_send", {
      phone_id: settings.phoneId,
      request_id: delivery.requestId,
      provider_id: delivery.id,
      next_status: delivery.status,
    });
    if (error) throw new Error("Delivery status could not be recorded");
  }

  if (touched.size) {
    await queueObservation(
      (async () => {
        const { data, error } = await supabaseAdmin
          .from("assistant_states")
          .select("conversation_id")
          .eq("mode", "observe")
          .in("conversation_id", [...touched]);
        if (error) throw error;
        for (const row of data) {
          await observeConversation(row.conversation_id);
        }
      })(),
    );
  }

  return new Response("OK");
}

Deno.serve(async (req) => {
  if (req.method === "GET") {
    const query = new URL(req.url).searchParams;
    const expected = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN");
    const challenge = query.get("hub.challenge");
    return expected &&
      query.get("hub.mode") === "subscribe" &&
      query.get("hub.verify_token") === expected &&
      challenge
      ? new Response(challenge, { headers: { "Content-Type": "text/plain" } })
      : new Response(null, { status: 403 });
  }
  if (req.method !== "POST") return new Response(null, { status: 405 });
  try {
    return await receive(req);
  } catch {
    // A non-2xx response lets Meta retry without exposing customer data or secrets.
    console.error("WhatsApp webhook processing failed");
    return new Response(null, { status: 503 });
  }
});
