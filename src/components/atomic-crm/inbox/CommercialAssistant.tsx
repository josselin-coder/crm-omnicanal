import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNotify } from "ra-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSupabaseClient } from "../providers/supabase/supabase";

type Decision = {
  id?: string;
  action: string;
  classification: string;
  reason: string;
  engine: string;
  created_at?: string;
  proposal?: string | null;
  facts: {
    name: string | null;
    service: string | null;
    quantity: number | null;
    files: string[];
  };
};

type Turn = {
  role: "customer" | "assistant";
  text: string;
  attachment?: { name: string; kind: string };
};

const services: Record<string, string> = {
  corte_laser: "Corte láser",
  grabado: "Grabado",
  cnc: "CNC",
  impresion_3d: "Impresión 3D",
};

const classes: Record<string, string> = {
  nuevo: "Nuevo",
  interesado: "Interesado",
  indeciso: "Indeciso",
  listo_para_ventas: "Listo para ventas",
  descartado: "Descartado",
};

const reasons: Record<string, string> = {
  next_question: "Faltan datos",
  waiting: "Datos recopilados",
  price_request: "Pidió precio o cotización",
  human_request: "Pidió atención humana",
  purchase_intent: "Intención de compra",
  brief_complete: "Servicio, diseño de referencia y cantidad confirmados",
  history_limit: "Historial extenso, requiere revisión humana",
  human_control: "Control humano",
  declined: "El cliente decidió no continuar",
};

const engines: Record<string, string> = {
  rules: "Reglas de simulación",
  model: "IA y reglas del servidor",
  rules_fallback: "Reglas del servidor",
};

const modes = {
  off: "Apagado",
  observe: "Observando",
  handoff: "Derivado",
  human: "Control humano",
} as const;

async function invoke<T>(body: Record<string, unknown>) {
  const { data, error } = await getSupabaseClient().functions.invoke<T>(
    "crm-assistant",
    { body },
  );
  if (error || !data) throw error ?? new Error("Asistente no disponible");
  return data;
}

function Summary({ decision }: { decision: Decision }) {
  const { name, service, quantity, files } = decision.facts;
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap gap-2">
        <Badge>{classes[decision.classification]}</Badge>
        <Badge variant="outline">{reasons[decision.reason]}</Badge>
      </div>
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
        <dt className="font-medium">Cliente</dt>
        <dd>{name || "Sin nombre indicado"}</dd>
        <dt className="font-medium">Servicio</dt>
        <dd>{service ? services[service] : "Por identificar"}</dd>
        <dt className="font-medium">Cantidad</dt>
        <dd>{quantity ?? "Por confirmar"}</dd>
        <dt className="font-medium">Archivos recibidos</dt>
        <dd className="break-words">
          {files.length ? files.join(", ") : "Ninguno"}
        </dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        {engines[decision.engine]}
      </p>
    </div>
  );
}

export function AssistantObservation({
  conversationId,
  canControl,
  sellerId,
}: {
  conversationId: string;
  canControl: boolean;
  sellerId: string | number;
}) {
  const queryClient = useQueryClient();
  const notify = useNotify();
  const query = useQuery({
    queryKey: ["assistant", sellerId, conversationId],
    meta: { persist: false },
    queryFn: () =>
      invoke<{ mode: keyof typeof modes; decisions: Decision[] }>({
        action: "read",
        conversationId,
      }),
  });
  const change = useMutation({
    mutationFn: (action: string) => invoke({ action, conversationId }),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["assistant", sellerId, conversationId],
        }),
        queryClient.invalidateQueries({ queryKey: ["inbox", sellerId] }),
      ]);
    },
    onError: () =>
      notify("No se pudo ejecutar la acción del asistente.", { type: "error" }),
  });
  const mode = query.data?.mode;
  const [latest, ...previous] = query.data?.decisions ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Asistente comercial</CardTitle>
        <p className="text-sm text-muted-foreground">
          Las sugerencias son internas. El vendedor envía las respuestas.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isPending && <p role="status">Cargando observación…</p>}
        {query.isError && (
          <p role="alert">No se pudo consultar el asistente.</p>
        )}
        {mode && <Badge variant="secondary">{modes[mode]}</Badge>}
        {latest && <Summary decision={latest} />}
        {mode === "observe" && latest?.proposal && (
          <p className="rounded-md bg-muted p-3 text-sm">
            Sugerencia interna · {latest.proposal}
          </p>
        )}
        {mode === "handoff" && (
          <p className="text-sm">
            {latest?.classification === "descartado"
              ? "El cliente declinó. La clasificación se actualizó."
              : "El asesor mantiene la conversación. Los cambios de intención quedan registrados."}
          </p>
        )}
        {canControl && mode && mode !== "human" && (
          <div className="flex flex-wrap gap-2">
            {mode === "off" && (
              <Button
                variant="outline"
                disabled={change.isPending}
                onClick={() => change.mutate("enable")}
              >
                Iniciar observación
              </Button>
            )}
            {(mode === "observe" || mode === "handoff") && (
              <>
                <Button
                  variant="outline"
                  disabled={change.isPending}
                  onClick={() => change.mutate("retry")}
                >
                  Actualizar análisis
                </Button>
                <Button
                  variant="outline"
                  disabled={change.isPending}
                  onClick={() => change.mutate("disable")}
                >
                  Apagar observación
                </Button>
              </>
            )}
            <Button
              disabled={change.isPending}
              onClick={() => change.mutate("take_control")}
            >
              Tomar control
            </Button>
          </div>
        )}
        {latest && (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">
              Registro de decisiones
            </summary>
            <ul className="mt-2 space-y-1">
              {[latest, ...previous].map((decision) => (
                <li key={decision.id}>
                  {decision.created_at
                    ? new Date(decision.created_at).toLocaleString("es-PE", {
                        timeZone: "America/Lima",
                      })
                    : ""}{" "}
                  · {reasons[decision.reason]} · {engines[decision.engine]}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

export function AssistantSimulator() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState("");
  const [simulationTime, setSimulationTime] = useState("");
  const [useModel, setUseModel] = useState(false);
  const [controlled, setControlled] = useState(false);
  const [handedOff, setHandedOff] = useState(false);
  const [decision, setDecision] = useState<Decision>();
  const notify = useNotify();
  const mutation = useMutation({
    mutationFn: ({
      transcript,
      stopped,
    }: {
      transcript: Turn[];
      stopped: boolean;
    }) =>
      invoke<{ decision: Decision; proposal: string | null }>({
        action: "simulate",
        transcript,
        stopped,
        afterHandoff: handedOff,
        useModel,
        time: simulationTime ? simulationTime + "-05:00" : undefined,
      }),
    onError: () => notify("No se pudo simular este turno.", { type: "error" }),
  });
  const paused = controlled;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (paused || mutation.isPending || (!draft.trim() && !attachment.trim()))
      return;
    const next: Turn[] = [
      ...turns,
      {
        role: "customer",
        text: draft.trim(),
        attachment: attachment.trim()
          ? {
              name: attachment.trim(),
              kind: /\.(png|jpe?g|webp|gif|heic)$/i.test(attachment.trim())
                ? "image"
                : "document",
            }
          : undefined,
      },
    ];
    try {
      const response = await mutation.mutateAsync({
        transcript: next,
        stopped: false,
      });
      setDecision(response.decision);
      if (response.decision.action === "handoff") setHandedOff(true);
      setTurns(
        response.proposal
          ? [...next, { role: "assistant", text: response.proposal }]
          : next,
      );
      setDraft("");
      setAttachment("");
    } catch {
      // Keep the customer's synthetic input available for another attempt.
    }
  }

  async function takeControl() {
    setControlled(true);
    try {
      const response = await mutation.mutateAsync({
        transcript: turns,
        stopped: true,
      });
      setDecision(response.decision);
    } catch {
      // Simulation still stops locally.
    }
  }

  return (
    <Card className="mx-4 mb-24">
      <CardHeader>
        <CardTitle>Simulador del asistente</CardTitle>
        <p className="text-sm text-muted-foreground">
          Usa datos ficticios. Cada turno genera una sugerencia de prueba y
          queda registrado.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            Hora de Lima (opcional)
            <input
              type="datetime-local"
              value={simulationTime}
              onChange={(event) => setSimulationTime(event.target.value)}
              className="rounded-md border bg-background p-2"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={useModel}
              onChange={(event) => setUseModel(event.target.checked)}
            />
            Usar el modelo configurado
          </label>
        </div>
        <ol className="space-y-2">
          {turns.map((turn, index) => (
            <li key={index} className="rounded-md border p-2 text-sm">
              <strong>
                {turn.role === "customer"
                  ? "Cliente simulado"
                  : "Sugerencia"}{" "}
              </strong>
              <span className="whitespace-pre-wrap">{turn.text}</span>
              {turn.attachment && (
                <p>Adjunto simulado · {turn.attachment.name}</p>
              )}
            </li>
          ))}
        </ol>
        {decision && <Summary decision={decision} />}
        {paused && <p role="status">Simulación pausada.</p>}
        {handedOff && !paused && (
          <p role="status">Derivado. Puedes simular un cambio de intención.</p>
        )}
        <form className="grid gap-2" onSubmit={(event) => void submit(event)}>
          <label className="grid gap-1 text-sm">
            Mensaje del cliente
            <textarea
              value={draft}
              maxLength={4096}
              disabled={paused || mutation.isPending}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              className="rounded-md border bg-background p-2"
            />
          </label>
          <label className="grid gap-1 text-sm">
            Nombre del archivo simulado (opcional)
            <input
              type="text"
              value={attachment}
              maxLength={160}
              disabled={paused || mutation.isPending}
              onChange={(event) => setAttachment(event.target.value)}
              className="rounded-md border bg-background p-2"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={
                paused ||
                mutation.isPending ||
                (!draft.trim() && !attachment.trim())
              }
            >
              Simular turno
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={controlled || mutation.isPending}
              onClick={() => void takeControl()}
            >
              Tomar control
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => {
                setTurns([]);
                setDecision(undefined);
                setControlled(false);
                setHandedOff(false);
                setDraft("");
                setAttachment("");
              }}
            >
              Reiniciar
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
