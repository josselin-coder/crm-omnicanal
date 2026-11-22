import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNotify } from "ra-core";
import { Button } from "@/components/ui/button";
import { getSupabaseClient } from "../providers/supabase/supabase";

const sendErrors: Record<string, string> = {
  forbidden: "Ya no tienes permiso para responder a esta conversación.",
  archived: "Restaura al cliente antes de responder.",
  window_closed: "La ventana de 24 horas terminó. Espera un nuevo mensaje del cliente.",
  whatsapp_not_configured: "WhatsApp todavía no está configurado en el servidor.",
  unauthenticated: "Tu sesión venció. Vuelve a iniciar sesión.",
  invalid_message: "Revisa el contenido del mensaje.",
  conflict: "No se pudo recuperar este envío. Revisa el historial antes de responder.",
  reservation_unavailable: "No se pudo confirmar el envío. Consulta su estado antes de intentarlo de nuevo.",
};

export const deliveryLabels: Record<string, string> = {
  pending: "Pendiente de confirmación",
  accepted: "Recibido por WhatsApp",
  sent: "Enviado",
  delivered: "Entregado",
  read: "Leído",
  failed: "Envío rechazado",
  unknown: "Entrega sin confirmar",
};

type SendResult = { status: string };
type SendAttempt = { requestId: string; text: string };

export function WhatsAppComposer({ conversationId }: { conversationId: string }) {
  const [draft, setDraft] = useState("");
  const [attempt, setAttempt] = useState<SendAttempt>();
  const [sending, setSending] = useState(false);
  const notify = useNotify();
  const queryClient = useQueryClient();

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending || !draft.trim()) return;

    const pending = attempt ?? { requestId: crypto.randomUUID(), text: draft.trim() };
    setAttempt(pending);
    setSending(true);
    try {
      const { data, error } = await getSupabaseClient().functions.invoke<SendResult>("whatsapp-inbox", {
        body: { action: "send", conversationId, ...pending },
      });
      if (error || !data) {
        const context = error?.context;
        const result = context instanceof Response ? await context.json().catch(() => null) : null;
        const code = typeof result?.error === "string" ? result.error : "";
        if (code && code !== "reservation_unavailable") setAttempt(undefined);
        notify(sendErrors[code] ?? "No se pudo confirmar el envío. Vuelve a consultar el mismo intento.", { type: "warning" });
        return;
      }
      setAttempt(undefined);
      setDraft("");
      if (data.status === "unknown" || data.status === "pending") {
        notify("Entrega sin confirmar. Revisa el historial antes de volver a enviar.", { type: "warning" });
      } else if (data.status === "failed") {
        notify("WhatsApp rechazó el envío.", { type: "error" });
      }
    } catch {
      notify("No se pudo confirmar el envío. Vuelve a consultar el mismo intento.", { type: "warning" });
    } finally {
      setSending(false);
      await queryClient.invalidateQueries({ queryKey: ["inbox"] });
    }
  }

  return (
    <form className="space-y-2 border-t pt-4" onSubmit={(event) => void send(event)}>
      <label className="block text-sm" htmlFor="whatsapp-reply">Responder por WhatsApp</label>
      <textarea
        id="whatsapp-reply"
        className="w-full rounded-md border bg-background p-2 text-sm"
        rows={3}
        maxLength={4096}
        value={draft}
        disabled={sending || Boolean(attempt)}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button type="submit" disabled={sending || !draft.trim()}>
        {sending ? "Consultando…" : attempt ? "Consultar envío" : "Enviar respuesta"}
      </Button>
    </form>
  );
}

export function WhatsAppAttachment({ messageId, name }: { messageId: string; name: string }) {
  const [loading, setLoading] = useState(false);
  const notify = useNotify();

  async function download() {
    setLoading(true);
    try {
      const { data, error } = await getSupabaseClient().functions.invoke<{ url: string }>("whatsapp-inbox", {
        body: { action: "attachment", messageId },
      });
      if (error || !data?.url) throw error;
      const link = document.createElement("a");
      link.href = data.url;
      link.rel = "noreferrer";
      link.click();
    } catch {
      notify("No se pudo descargar el adjunto.", { type: "error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void download()}>
      Descargar {name}
    </Button>
  );
}
