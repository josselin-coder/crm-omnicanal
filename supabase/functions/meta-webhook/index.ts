import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { observeConversation, queueObservation } from "../_shared/assistantObserver.ts";
import {
  isMetaAttachmentUrl,
  metaEvents,
  metaMediaLimit,
  metaProviderKey,
  metaWebhookChannel,
  signatureAccounts,
} from "../_shared/metaMessaging.ts";
import { BodyTooLarge, object, readLimited, string, verifySignature } from "../_shared/whatsapp.ts";

const bucket = "meta-messaging-media";

async function downloadMedia(initial: string) {
  let url = initial;
  for (let redirect = 0; redirect <= 2; redirect++) {
    if (!isMetaAttachmentUrl(url)) return { failure: "unsupported_media_url", retry: false } as const;
    // Webhook attachment URLs carry their own scoped access. Never forward a Graph token to a CDN.
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = response.headers.get("location");
      if (!next) break;
      url = new URL(next, url).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { failure: "cdn_http_" + response.status, retry: response.status === 429 || response.status >= 500 } as const;
    }
    if (Number(response.headers.get("content-length")) > metaMediaLimit) {
      await response.body?.cancel();
      return { failure: "media_too_large", retry: false } as const;
    }
    const bytes = await readLimited(response.body, metaMediaLimit);
    if (!bytes.length) return { failure: "empty_media", retry: false } as const;

    const type = response.headers.get("content-type")?.split(";")[0]?.toLowerCase() ?? "";
    const mime = /^(?:image\/(?:jpeg|png|gif|webp|heic)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|application\/pdf)$/.test(type)
      ? type
      : "application/octet-stream";
    const disposition = response.headers.get("content-disposition") ?? "";
    const suppliedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    let name = disposition.match(/filename="([^"]+)"/i)?.[1] ?? "";
    if (suppliedName) {
      try {
        name = decodeURIComponent(suppliedName);
      } catch {
        // Keep the ordinary filename when the extended filename is malformed.
      }
    }
    const safeName = Array.from(name, (character) => {
      const code = character.charCodeAt(0);
      return character === "/" || character === "\\" || code < 32 || code === 127 ? "_" : character;
    }).join("").trim().slice(0, 160);
    return { bytes, mime, name: safeName || null };
  }
  return { failure: "cdn_redirect_limit", retry: false } as const;
}

async function saveMedia(messageId: string) {
  const { data, error } = await supabaseAdmin.rpc("claim_meta_media", { target: messageId });
  if (error) throw new Error("Attachment claim failed");

  let retry = false;
  for (const item of data ?? []) {
    let failure: string | null = null;
    let recoverable = false;
    let path: string | null = null;
    let mime: string | null = null;
    let name: string | null = null;
    try {
      const media = await downloadMedia(item.source_url);
      if (media.failure !== undefined) {
        failure = media.failure;
        recoverable = media.retry;
      } else {
        const objectPath = `${messageId}/${item.id}`;
        const { error: uploadError } = await supabaseAdmin.storage.from(bucket).upload(objectPath, media.bytes, {
          upsert: true,
          contentType: media.mime,
        });
        if (uploadError) {
          failure = "private_storage_upload";
          recoverable = true;
        } else {
          path = objectPath;
          mime = media.mime;
          name = media.name;
        }
      }
    } catch (error) {
      failure = error instanceof BodyTooLarge ? "media_too_large" : "cdn_unavailable";
      recoverable = !(error instanceof BodyTooLarge);
    }
    retry ||= recoverable && item.attempts < 5;
    const { error: completeError } = await supabaseAdmin.rpc("finish_meta_media", {
      target: item.id, token: item.claim, next_state: path ? "ready" : recoverable ? "pending" : "unavailable",
      saved_path: path, saved_mime: mime, saved_name: name, failure,
    });
    if (completeError) throw new Error("Attachment result could not be persisted");
  }
  return retry;
}

Deno.serve(async (request) => {
  if (request.method === "GET") {
    const query = new URL(request.url).searchParams;
    const expected = Deno.env.get("META_MESSAGING_VERIFY_TOKEN");
    const challenge = query.get("hub.challenge");
    return expected && query.get("hub.mode") === "subscribe" && query.get("hub.verify_token") === expected && challenge
      ? new Response(challenge, { headers: { "Content-Type": "text/plain" } })
      : new Response(null, { status: 403 });
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });

  const configured = signatureAccounts();
  if (!configured.length) return new Response(null, { status: 503 });
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readLimited(request.body, 1024 * 1024);
  } catch (error) {
    return new Response(null, { status: error instanceof BodyTooLarge ? 413 : 400 });
  }
  const signature = request.headers.get("x-hub-signature-256");
  const matches = await Promise.all(configured.map(async (setting) => ({
    setting, verified: await verifySignature(bytes, signature, setting.secret),
  })));
  if (!matches.some(({ verified }) => verified)) return new Response(null, { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return new Response(null, { status: 400 });
  }
  const channel = metaWebhookChannel(payload);
  if (!channel) return new Response("OK");
  const config = matches.find(({ setting, verified }) => setting.channel === channel && verified)?.setting;
  if (!config) return new Response(null, { status: 401 });

  let retry = false;
  const touched = new Set<string>();
  try {
    for (const event of metaEvents(payload, channel, config.account)) {
      if (event.type === "receipt") {
        const { error } = await supabaseAdmin.rpc("update_meta_delivery", {
          p_channel: channel, account: config.account, peer: event.peer,
          request_id: event.request, provider_ids: event.ids.map((id) => metaProviderKey(channel, config.account, id)),
          through_at: event.through, next_status: event.status,
        });
        if (error) throw new Error("Receipt could not be stored");
        continue;
      }

      const { data, error } = await supabaseAdmin.rpc("receive_meta_message", {
        p_channel: channel, account: config.account, sender: event.peer, external_id: event.id,
        received_at: event.timestamp, body_text: event.text, attachments: event.attachments,
      });
      if (error || !data) throw new Error("Inbound message could not be stored");

      const stored = object(data);
      touched.add(string(stored.conversation_id));
      if (event.attachments.length) {
        const needsRetry = await saveMedia(string(stored.id));
        retry ||= needsRetry;
      }
    }
  } catch {
    await supabaseAdmin.from("meta_transport_errors").insert({ channel, stage: "webhook", code: "processing_failed" });
    retry = true;
  }

  if (touched.size) {
    await queueObservation((async () => {
      for (const id of touched) await observeConversation(id);
    })());
  }
  return new Response(retry ? null : "OK", { status: retry ? 503 : 200 });
});
