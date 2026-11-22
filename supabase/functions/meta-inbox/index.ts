import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { metaChannel, metaProviderKey, metaSendPayload, metaSettings, providerMessageId } from "../_shared/metaMessaging.ts";
import { BodyTooLarge, object, readLimited, string, uuidPattern } from "../_shared/whatsapp.ts";

const bucket = "meta-messaging-media";
const respond = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { ...corsHeaders, "Cache-Control": "no-store" } });

Deno.serve((request) => OptionsMiddleware(request, async () => {
  if (request.method !== "POST") return respond({ error: "method_not_allowed" }, 405);
  const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) return respond({ error: "unauthenticated" }, 401);

  const client = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
  const { data: identity, error: authError } = await client.auth.getUser(token);
  if (authError || !identity.user) return respond({ error: "unauthenticated" }, 401);

  let payload: Record<string, unknown>;
  try {
    payload = object(JSON.parse(new TextDecoder().decode(await readLimited(request.body, 24 * 1024))));
  } catch (error) {
    return respond({ error: "invalid_body" }, error instanceof BodyTooLarge ? 413 : 400);
  }

  if (payload.action === "attachment") {
    const id = string(payload.attachmentId);
    if (!uuidPattern.test(id)) return respond({ error: "invalid_attachment" }, 400);
    const { data: visible, error } = await client
      .from("meta_message_attachments")
      .select("id, name, mime, state")
      .eq("id", id)
      .maybeSingle();
    if (error || visible?.state !== "ready") return respond({ error: "attachment_not_found" }, 404);

    const { data: asset, error: assetError } = await supabaseAdmin
      .from("meta_message_attachments").select("storage_path").eq("id", id).single();
    if (assetError || !asset.storage_path) return respond({ error: "attachment_unavailable" }, 503);

    const preview = payload.preview === true && /^image\/(jpeg|png|gif|webp)$/.test(visible.mime ?? "");
    const { data, error: signedError } = await supabaseAdmin.storage.from(bucket)
      .createSignedUrl(asset.storage_path, 60, { download: preview ? false : visible.name || true });
    if (signedError) return respond({ error: "attachment_unavailable" }, 503);

    const url = new URL(data.signedUrl);
    return respond({ path: url.pathname + url.search });
  }

  if (payload.action !== "send") return respond({ error: "invalid_action" }, 400);
  const channel = metaChannel(payload.channel);
  const conversationId = string(payload.conversationId);
  const requestId = string(payload.requestId);
  const text = string(payload.text).trim();
  if (!channel || !uuidPattern.test(conversationId) || !uuidPattern.test(requestId) || !text || text.length > 1000) {
    return respond({ error: "invalid_message" }, 400);
  }
  const config = metaSettings(channel);
  if (!config) return respond({ error: "meta_not_configured" }, 503);

  const { data, error } = await supabaseAdmin.rpc("reserve_meta_send", {
    actor_user: identity.user.id, thread_id: conversationId, request_id: requestId,
    p_channel: channel, account: config.account, body_text: text,
  });
  if (error) return respond({ error: "reservation_unavailable" }, 503);
  const reservation = object(data);
  if (reservation.error) return respond(reservation, reservation.error === "forbidden" ? 403 : 409);
  if (!reservation.claimed) return respond({ status: reservation.status });

  const peer = string(reservation.recipient);
  let status = "unknown";
  let providerIds: string[] | null = null;
  let failure: string | null = null;
  try {
    const result = await fetch(`${config.base}/${config.account}/messages`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(metaSendPayload(channel, peer, text, requestId)),
    });
    if (result.ok) {
      const id = providerMessageId(object(await result.json()).message_id);
      if (id) {
        providerIds = [metaProviderKey(channel, config.account, id)];
        status = "accepted";
      } else {
        failure = "missing_provider_message_id";
      }
    } else {
      failure = "graph_http_" + result.status;
      if (result.status >= 400 && result.status < 500 && result.status !== 408) status = "failed";
    }
  } catch {
    failure = "graph_outcome_unknown";
  }

  const { error: saveError } = await supabaseAdmin.rpc("update_meta_delivery", {
    p_channel: channel, account: config.account, peer, request_id: requestId,
    provider_ids: providerIds, through_at: null, next_status: status,
  });
  if (saveError || failure) {
    await supabaseAdmin.from("meta_transport_errors").insert({
      channel, stage: "send", code: saveError ? "send_status_write_failed" : failure,
      conversation_id: conversationId,
    });
  }
  return respond({ status: saveError ? "unknown" : status });
}));
