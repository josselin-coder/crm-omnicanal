import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { proposalFor } from "../_shared/assistant.ts";
import {
  analyze,
  observeConversation,
  parseTranscript,
  queueObservation,
} from "../_shared/assistantObserver.ts";
import {
  BodyTooLarge,
  object,
  readLimited,
  string,
  uuidPattern,
} from "../_shared/whatsapp.ts";

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

    const { data: actor, error: actorError } = await client
      .from("sales")
      .select("id, disabled")
      .eq("user_id", identity.user.id)
      .maybeSingle();
    if (actorError || !actor || actor.disabled)
      return respond({ error: "forbidden" }, 403);

    let payload: Record<string, unknown>;
    try {
      payload = object(
        JSON.parse(
          new TextDecoder().decode(await readLimited(req.body, 300 * 1024)),
        ),
      );
    } catch (error) {
      return respond(
        { error: "invalid_body" },
        error instanceof BodyTooLarge ? 413 : 400,
      );
    }

    try {
      if (payload.action === "simulate") {
        const transcript = parseTranscript(payload.transcript);
        const time = payload.time
          ? Date.parse(string(payload.time))
          : Date.now();
        if (!transcript || !Number.isFinite(time))
          return respond({ error: "invalid_simulation" }, 400);
        const decision = await analyze(
          transcript,
          new Date(time),
          payload.useModel === true,
          payload.stopped === true,
        );
        const { error } = await supabaseAdmin
          .from("assistant_decisions")
          .insert({
            ...decision,
            mode: "simulation",
            actor_id: actor.id,
          });
        if (error) throw new Error("Simulation could not be recorded");
        return respond({ decision, proposal: proposalFor(decision.action) });
      }

      const target = string(payload.conversationId);
      if (!uuidPattern.test(target))
        return respond({ error: "invalid_conversation" }, 400);

      if (
        payload.action === "take_control" ||
        payload.action === "enable" ||
        payload.action === "disable"
      ) {
        const { data: mode, error } = await supabaseAdmin.rpc(
          "control_inbox_assistant",
          {
            actor_user: identity.user.id,
            target,
            command: payload.action,
          },
        );
        if (error) throw new Error("Assistant control could not be changed");
        if (mode === "forbidden") return respond({ error: mode }, 403);
        if (mode === "archived") return respond({ error: mode }, 409);
        if (payload.action === "enable" && mode === "observe") {
          await queueObservation(observeConversation(target));
        }
        return respond({ ok: true });
      }

      if (payload.action === "retry") {
        const { data: visible, error } = await client
          .from("assistant_states")
          .select("mode")
          .eq("conversation_id", target)
          .maybeSingle();
        if (error || visible?.mode !== "observe")
          return respond({ error: "forbidden" }, 403);
        await queueObservation(observeConversation(target));
        return respond({ ok: true });
      }

      if (payload.action === "read") {
        const { data: visible, error } = await client
          .from("inbox_conversations")
          .select("id")
          .eq("id", target)
          .maybeSingle();
        if (error || !visible) return respond({ error: "forbidden" }, 403);
        const [state, audit] = await Promise.all([
          client
            .from("assistant_states")
            .select("mode, updated_at")
            .eq("conversation_id", target)
            .maybeSingle(),
          client
            .from("assistant_decisions")
            .select(
              "id, action, reason, classification, engine, facts, created_at",
            )
            .eq("conversation_id", target)
            .order("revision", { ascending: false })
            .limit(25),
        ]);
        if (state.error || audit.error)
          throw new Error("Assistant history could not be loaded");
        return respond({
          mode: state.data?.mode ?? "off",
          decisions: audit.data.map((decision) => ({
            ...decision,
            proposal: proposalFor(decision.action),
          })),
        });
      }

      return respond({ error: "invalid_action" }, 400);
    } catch {
      console.error("CRM assistant request failed");
      return respond({ error: "assistant_unavailable" }, 503);
    }
  }),
);
