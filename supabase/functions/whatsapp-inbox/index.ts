import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import {
  BodyTooLarge,
  cloudSettings,
  object,
  readLimited,
  string,
  uuidPattern,
  whatsappDestination,
} from "../_shared/whatsapp.ts";

const bucket = "whatsapp-media";
const respond = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { ...corsHeaders, "Cache-Control": "no-store" },
  });

Deno.serve((req) =>
  OptionsMiddleware(req, async () => {
    if (req.method !== "POST")
      return respond({ error: "method_not_allowed" }, 405);

    const token = req.headers
      .get("authorization")
      ?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) return respond({ error: "unauthenticated" }, 401);

    const client = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { autoRefreshToken: false, persistSession: false },
      },
    );
    const { data: identity, error: authError } =
      await client.auth.getUser(token);
    if (authError || !identity.user)
      return respond({ error: "unauthenticated" }, 401);

    let payload: Record<string, unknown>;
    try {
      payload = object(
        JSON.parse(
          new TextDecoder().decode(await readLimited(req.body, 32 * 1024)),
        ),
      );
    } catch (error) {
      return respond(
        { error: "invalid_body" },
        error instanceof BodyTooLarge ? 413 : 400,
      );
    }

    if (payload.action === "attachment") {
      const id = string(payload.messageId);
      if (!uuidPattern.test(id))
        return respond({ error: "invalid_message" }, 400);
      const { data: message, error } = await client
        .from("inbox_messages")
        .select("attachment_path, attachment_name")
        .eq("id", id)
        .maybeSingle();
      if (error || !message?.attachment_path)
        return respond({ error: "attachment_not_found" }, 404);

      const { data, error: signedError } = await supabaseAdmin.storage
        .from(bucket)
        .createSignedUrl(message.attachment_path, 60, {
          download: message.attachment_name || true,
        });
      if (signedError) return respond({ error: "attachment_unavailable" }, 503);
      const url = new URL(data.signedUrl);
      return respond({ path: url.pathname + url.search });
    }

    if (payload.action !== "send")
      return respond({ error: "invalid_action" }, 400);
    const conversation = string(payload.conversationId);
    const requestId = string(payload.requestId);
    const text = string(payload.text).trim();
    if (
      !uuidPattern.test(conversation) ||
      !uuidPattern.test(requestId) ||
      !text ||
      text.length > 4096
    ) {
      return respond({ error: "invalid_message" }, 400);
    }

    const settings = cloudSettings();
    if (!settings) return respond({ error: "whatsapp_not_configured" }, 503);
    const { data: reservation, error: reserveError } = await supabaseAdmin.rpc(
      "reserve_whatsapp_send",
      {
        actor_user: identity.user.id,
        thread_id: conversation,
        request_id: requestId,
        phone_id: settings.phoneId,
        message_body: text,
      },
    );
    if (reserveError) return respond({ error: "reservation_unavailable" }, 503);
    const claim = object(reservation);
    if (claim.error)
      return respond(claim, claim.error === "forbidden" ? 403 : 409);
    if (!claim.claimed) return respond({ status: claim.status });

    let status = "unknown";
    let providerId: string | null = null;
    try {
      const result = await fetch(
        `${settings.base}/${settings.phoneId}/messages`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: {
            Authorization: `Bearer ${settings.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            ...whatsappDestination(string(claim.recipient)),
            type: "text",
            text: { body: text, preview_url: false },
            biz_opaque_callback_data: requestId,
          }),
        },
      );
      if (result.ok) {
        const answer = object(await result.json());
        const id = Array.isArray(answer.messages)
          ? string(object(answer.messages[0]).id)
          : "";
        if (/^wamid\.[A-Za-z0-9._+=/-]{1,500}$/.test(id)) {
          providerId = id;
          status = "accepted";
        }
      } else if (
        result.status >= 400 &&
        result.status < 500 &&
        result.status !== 408
      ) {
        status = "failed";
      }
    } catch {
      // The provider may have accepted the request. Never resend an ambiguous call.
    }

    const { error: updateError } = await supabaseAdmin.rpc(
      "update_whatsapp_send",
      {
        phone_id: settings.phoneId,
        request_id: requestId,
        provider_id: providerId,
        next_status: status,
      },
    );
    return respond({ status: updateError ? "unknown" : status });
  }),
);
