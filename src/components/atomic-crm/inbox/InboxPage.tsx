import { useState } from "react";
import { WhatsAppAttachment, WhatsAppComposer } from "./WhatsAppConversation";
import { AssistantObservation, AssistantSimulator } from "./CommercialAssistant";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useGetIdentity, useNotify } from "ra-core";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSupabaseClient } from "../providers/supabase/supabase";
import { setContactArchived } from "../providers/supabase/setContactArchived";
import { config } from "../root/config";

const deliveryLabels: Record<string, string> = {
  pending: "Pendiente de confirmación",
  accepted: "Recibido por WhatsApp",
  sent: "Enviado",
  delivered: "Entregado",
  read: "Leído",
  failed: "Envío rechazado",
  unknown: "Entrega sin confirmar",
};

const channels = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
};

const classifications = {
  nuevo: "Nuevo",
  interesado: "Interesado",
  indeciso: "Indeciso",
  listo_para_ventas: "Listo para ventas",
  comprado: "Comprado",
  descartado: "Descartado",
};

const pageSize = 25;
const selectClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";
const dateFormat = new Intl.DateTimeFormat("es", {
  dateStyle: "short",
  timeStyle: "short",
});

type Channel = keyof typeof channels;
type Conversation = {
  id: string;
  channel: Channel;
  assigned_sales_id: number | null;
  last_message_at: string;
  last_inbound_at: string | null;
  whatsapp_phone_id: string | null;
  customer: {
    contact_id: number;
    classification: keyof typeof classifications;
    contact: {
      archived_at: string | null;
      first_name: string | null;
      last_name: string | null;
      email_jsonb: { email: string }[] | null;
      phone_jsonb: { number: string }[] | null;
    };
  };
};

function contactName({ customer }: Conversation) {
  const { first_name, last_name } = customer.contact;
  return (
    [first_name, last_name].filter(Boolean).join(" ") || "Cliente sin nombre"
  );
}

export function InboxPage() {
  const [simulating, setSimulating] = useState(false);
  const { identity, isPending, error } = useGetIdentity();

  if (isPending) return <p role="status">Cargando bandeja…</p>;
  if (error || !identity)
    return <p role="alert">No se pudo verificar tu sesión.</p>;

  if (!config.supabaseUrl)
    return <p>La bandeja requiere una instancia de Supabase.</p>;

  return (
    <>
      <div className="flex justify-end px-4 pt-3 md:px-0">
        <Button variant="outline" onClick={() => setSimulating(!simulating)}>
          {simulating ? "Volver a la bandeja" : "Abrir simulador"}
        </Button>
      </div>
      {simulating ? (
        <AssistantSimulator key={identity.id} />
      ) : (
        <Inbox key={identity.id} sellerId={identity.id} />
      )}
    </>
  );
}

function Inbox({ sellerId }: { sellerId: string | number }) {
  const [archived, setArchived] = useState(false);
  const [channel, setChannel] = useState<Channel | "">("");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const client = getSupabaseClient();
  const query = useQuery({
    queryKey: ["inbox", sellerId, "conversations", archived, channel, page],
    meta: { persist: false },
    queryFn: async () => {
      let request = client
        .from("inbox_conversations")
        .select(
          "id, channel, assigned_sales_id, last_message_at, last_inbound_at, whatsapp_phone_id, customer:inbox_customers!inner(contact_id, classification, contact:contacts!inner(archived_at, first_name, last_name, email_jsonb, phone_jsonb))",
        );
      request = archived
        ? request.not("customer.contact.archived_at", "is", null)
        : request.is("customer.contact.archived_at", null);
      if (channel) request = request.eq("channel", channel);
      const { data, error } = await request
        .order("last_message_at", { ascending: false })
        .order("id", { ascending: false })
        .range(page * pageSize, (page + 1) * pageSize)
        .returns<Conversation[]>();
      if (error) throw error;
      return {
        items: data.slice(0, pageSize),
        hasNext: data.length > pageSize,
      };
    },
  });
  const items = query.data?.items ?? [];
  const selected = items.find((item) => item.id === selectedId);

  return (
    <section className="space-y-4 p-4 pb-24 md:p-0">
      <div>
        <h2 className="text-2xl font-semibold">Bandeja omnicanal</h2>
        <p className="text-sm text-muted-foreground">
          WhatsApp Business y conversaciones de demostración.
        </p>
      </div>
      <div className="grid items-start gap-4 md:grid-cols-[minmax(15rem,1fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Conversaciones</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="block space-y-1 text-sm">
              <span>Archivo</span>
              <select
                className={selectClass}
                value={archived ? "archived" : "active"}
                onChange={(event) => {
                  setArchived(event.target.value === "archived");
                  setPage(0);
                  setSelectedId(undefined);
                }}
              >
                <option value="active">Clientes activos</option>
                <option value="archived">Clientes archivados</option>
              </select>
            </label>
            <label className="block space-y-1 text-sm">
              <span>Canal</span>
              <select
                className={selectClass}
                value={channel}
                onChange={(event) => {
                  setChannel(event.target.value as Channel | "");
                  setPage(0);
                  setSelectedId(undefined);
                }}
              >
                <option value="">Todos los canales</option>
                {Object.entries(channels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {query.isPending && <p role="status">Cargando conversaciones…</p>}
            {query.isError && (
              <div role="alert">
                <p>No se pudieron cargar las conversaciones.</p>
                <Button variant="outline" onClick={() => void query.refetch()}>
                  Reintentar
                </Button>
              </div>
            )}
            {query.isSuccess && items.length === 0 && (
              <p>No hay conversaciones en esta vista.</p>
            )}
            <ul className="divide-y">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-pressed={item.id === selectedId}
                    className="w-full space-y-1 rounded-md p-2 text-left hover:bg-accent aria-pressed:bg-accent"
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className="block font-medium">
                      {contactName(item)}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {channels[item.channel]} ·{" "}
                      {classifications[item.customer.classification]}
                    </span>
                    <time
                      className="text-xs text-muted-foreground"
                      dateTime={item.last_message_at}
                    >
                      {dateFormat.format(new Date(item.last_message_at))}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
            <Pagination
              page={page}
              hasNext={query.data?.hasNext}
              onChange={(next) => {
                setSelectedId(undefined);
                setPage(next);
              }}
            />
          </CardContent>
        </Card>

        {selected ? (
          <ConversationDetail
            key={selected.id}
            conversation={selected}
            sellerId={sellerId}
            onArchiveChange={() => {
              setPage(0);
              setSelectedId(undefined);
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Selecciona una conversación para ver la ficha y los mensajes.
          </p>
        )}
      </div>
    </section>
  );
}

function Pagination({
  page,
  hasNext,
  onChange,
}: {
  page: number;
  hasNext?: boolean;
  onChange: (page: number) => void;
}) {
  if (page === 0 && !hasNext) return null;

  return (
    <div className="flex items-center justify-between gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={!page}
        onClick={() => onChange(page - 1)}
      >
        Anterior
      </Button>
      <span className="text-sm">Página {page + 1}</span>
      <Button
        size="sm"
        variant="outline"
        disabled={!hasNext}
        onClick={() => onChange(page + 1)}
      >
        Siguiente
      </Button>
    </div>
  );
}

function ConversationDetail({
  conversation,
  sellerId,
  onArchiveChange,
}: {
  conversation: Conversation;
  sellerId: string | number;
  onArchiveChange: () => void;
}) {
  const client = getSupabaseClient();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const [page, setPage] = useState(0);
  const { customer } = conversation;

  const staffQuery = useQuery({
    queryKey: ["inbox", sellerId, "staff"],
    meta: { persist: false },
    queryFn: async () => {
      const { data, error } = await client
        .from("sales")
        .select("id, first_name, last_name, administrator, disabled")
        .order("first_name")
        .order("id");
      if (error) throw error;
      return data;
    },
  });
  const staff = staffQuery.data ?? [];
  const actor = staff.find((seller) => String(seller.id) === String(sellerId));
  const canAssign = actor?.administrator && !actor.disabled;
  const canReply =
    actor &&
    !actor.disabled &&
    (actor.administrator || actor.id === conversation.assigned_sales_id) &&
    !customer.contact.archived_at;
  const lastInbound = conversation.last_inbound_at;
  const windowOpen = Boolean(
    lastInbound && Date.now() - Date.parse(lastInbound) < 86_400_000,
  );
  const assignee = staff.find(
    (seller) => seller.id === conversation.assigned_sales_id,
  );

  const history = useQuery({
    queryKey: ["inbox", sellerId, "messages", conversation.id, page],
    meta: { persist: false },
    queryFn: async () => {
      const { data, error } = await client
        .from("inbox_messages")
        .select("id, direction, body, sent_at, attachment_name, send_status")
        .eq("conversation_id", conversation.id)
        .order("sent_at", { ascending: false })
        .order("id", { ascending: false })
        .range(page * pageSize, (page + 1) * pageSize);
      if (error) throw error;
      return {
        items: data.slice(0, pageSize).reverse(),
        hasNext: data.length > pageSize,
      };
    },
  });

  type Change =
    | { classification: string }
    | { archived: boolean }
    | { assigned_sales_id: number | null };

  const mutation = useMutation({
    mutationFn: async (change: Change) => {
      if ("archived" in change) {
        await setContactArchived(customer.contact_id, change.archived);
        return;
      }
      const request =
        "assigned_sales_id" in change
          ? client
              .from("inbox_conversations")
              .update(change)
              .eq("id", conversation.id)
              .select("id")
              .single()
          : client
              .from("inbox_customers")
              .update(change)
              .eq("contact_id", customer.contact_id)
              .select("contact_id")
              .single();
      const { error } = await request;
      if (error) throw error;
    },
    onSuccess: async (_, change) => {
      if ("archived" in change) {
        onArchiveChange();
        await queryClient.invalidateQueries({ queryKey: ["contacts"] });
      }
      await queryClient.invalidateQueries({
        queryKey: ["inbox", sellerId, "conversations"],
      });
      notify("Cambio guardado", { type: "success" });
    },
    onError: () =>
      notify(
        "No se pudo guardar el cambio. Verifica tus permisos e inténtalo de nuevo.",
        { type: "error" },
      ),
  });

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{contactName(conversation)}</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{channels[conversation.channel]}</Badge>
            {!conversation.whatsapp_phone_id && (
              <Badge variant="outline">Demostración</Badge>
            )}
            {customer.contact.archived_at && (
              <Badge variant="outline">Archivado</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1 text-sm">
            {customer.contact.email_jsonb?.map(({ email }, index) => (
              <p key={index} className="break-all">
                {email}
              </p>
            ))}
            {customer.contact.phone_jsonb?.map(({ number }, index) => (
              <p key={index}>{number}</p>
            ))}
            <Link
              className="underline"
              to={`/contacts/${customer.contact_id}/show`}
            >
              Abrir contacto en Atomic CRM
            </Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1 text-sm">
              <span>Clasificación</span>
              <select
                className={selectClass}
                value={customer.classification}
                disabled={mutation.isPending}
                onChange={(event) =>
                  mutation.mutate({ classification: event.target.value })
                }
              >
                {Object.entries(classifications).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {canAssign ? (
              <label className="block space-y-1 text-sm">
                <span>
                  {conversation.assigned_sales_id
                    ? "Transferir a vendedor"
                    : "Asignar vendedor"}
                </span>
                <select
                  className={selectClass}
                  value={conversation.assigned_sales_id ?? ""}
                  disabled={mutation.isPending}
                  onChange={(event) =>
                    mutation.mutate({
                      assigned_sales_id: event.target.value
                        ? Number(event.target.value)
                        : null,
                    })
                  }
                >
                  <option value="">Sin asignar</option>
                  {staff
                    .filter(
                      (seller) =>
                        !seller.disabled ||
                        seller.id === conversation.assigned_sales_id,
                    )
                    .map((seller) => (
                      <option
                        key={seller.id}
                        value={seller.id}
                        disabled={seller.disabled}
                      >
                        {seller.first_name} {seller.last_name}
                        {seller.disabled ? " (inactivo)" : ""}
                      </option>
                    ))}
                </select>
              </label>
            ) : (
              <p className="text-sm">
                Vendedor{" "}
                {assignee
                  ? `${assignee.first_name} ${assignee.last_name}`
                  : conversation.assigned_sales_id === null
                    ? "sin asignar"
                    : "asignado"}
              </p>
            )}
          </div>
          {staffQuery.isError && (
            <p role="alert">No se pudo cargar la lista de vendedores.</p>
          )}
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate({
                archived: !customer.contact.archived_at,
              })
            }
          >
            {customer.contact.archived_at
              ? "Restaurar cliente"
              : "Archivar cliente"}
          </Button>
        </CardContent>
      </Card>
      {conversation.whatsapp_phone_id && (
        <AssistantObservation
          conversationId={conversation.id}
          canControl={Boolean(canReply)}
          sellerId={sellerId}
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle>Historial de mensajes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {history.isPending && <p role="status">Cargando mensajes…</p>}
          {history.isError && (
            <p role="alert">No se pudo cargar el historial.</p>
          )}
          {history.isSuccess && history.data.items.length === 0 && (
            <p>No hay mensajes.</p>
          )}
          <ol className="space-y-3">
            {history.data?.items.map((message) => (
              <li key={message.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap justify-between gap-2 text-muted-foreground">
                  <span>
                    {message.direction === "incoming" ? "Cliente" : "Vendedor"}
                  </span>
                  <time dateTime={message.sent_at}>
                    {dateFormat.format(new Date(message.sent_at))}
                  </time>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words">
                  {message.body}
                </p>
                {message.attachment_name && (
                  <WhatsAppAttachment
                    messageId={message.id}
                    name={message.attachment_name}
                  />
                )}
                {message.send_status && (
                  <p className="text-xs text-muted-foreground">
                    {deliveryLabels[message.send_status]}
                  </p>
                )}
              </li>
            ))}
          </ol>
          <Pagination
            page={page}
            hasNext={history.data?.hasNext}
            onChange={setPage}
          />
          {conversation.whatsapp_phone_id &&
            canReply &&
            (windowOpen ? (
              <WhatsAppComposer conversationId={conversation.id} />
            ) : (
              <p className="text-sm text-muted-foreground">
                La ventana de 24 horas está cerrada. El cliente debe enviar un
                nuevo mensaje para habilitar respuestas de texto.
              </p>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}
