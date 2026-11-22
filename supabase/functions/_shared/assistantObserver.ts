import { supabaseAdmin } from "./supabaseAdmin.ts";
import { decide, historyLimit, type Decision, type Turn } from "./assistant.ts";
import { extractWithModel } from "./assistantModel.ts";
import { object, string } from "./whatsapp.ts";

export function parseTranscript(input: unknown): Turn[] | null {
  if (!Array.isArray(input) || input.length > historyLimit.turns) return null;
  let characters = 0;
  const transcript: Turn[] = [];
  for (const raw of input) {
    const turn = object(raw);
    if (turn.role !== "customer" && turn.role !== "seller" && turn.role !== "assistant") return null;
    if (typeof turn.text !== "string") return null;
    characters += turn.text.length;
    if (characters > historyLimit.characters) return null;
    const attachment = object(turn.attachment);
    const name = string(attachment.name).trim().slice(0, 160);
    transcript.push({
      role: turn.role,
      text: turn.text,
      attachment: name ? { name, kind: string(attachment.kind).slice(0, 32) } : null,
    });
  }
  return transcript;
}

export async function analyze(
  transcript: Turn[] | null,
  now: Date,
  useModel: boolean,
  stopped = false,
): Promise<Decision> {
  if (stopped) return decide(transcript ?? [], now, { stopped: true });
  if (!transcript) return decide([], now, { overflow: true });
  if (!useModel) return decide(transcript, now);

  const saidSomething = transcript.some((turn) => turn.role === "customer");
  const model = saidSomething ? await extractWithModel(transcript) : undefined;
  return decide(transcript, now, {
    model,
    engine: model ? "model" : "rules_fallback",
  });
}

export async function observeConversation(conversationId: string) {
  const { data, error } = await supabaseAdmin.rpc("claim_assistant_observation", {
    target: conversationId,
  });
  if (error) throw new Error("Observation could not be claimed");
  if (!data) return null;

  const claim = object(data);
  const decision = await analyze(parseTranscript(claim.transcript), new Date(), true);
  const { data: saved, error: saveError } = await supabaseAdmin.rpc("finish_assistant_observation", {
    target: conversationId,
    token: claim.token,
    expected_revision: claim.revision,
    decision,
  });
  if (saveError) throw new Error("Observation could not be saved");
  return saved ? decision : null;
}
