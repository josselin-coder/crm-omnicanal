import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetIdentity, useNotify } from "ra-core";
import { config } from "../root/config";
import { getSupabaseClient } from "../providers/supabase/supabase";

export function InboxNotifications() {
  const { identity } = useGetIdentity();
  const sellerId = identity?.id;
  const queryClient = useQueryClient();
  const notify = useNotify();

  useEffect(() => {
    if (!sellerId || !config.supabaseUrl) return;
    const client = getSupabaseClient();
    const refreshInbox = () =>
      void queryClient.invalidateQueries({ queryKey: ["inbox", sellerId] });
    const refreshAssistant = () =>
      void queryClient.invalidateQueries({ queryKey: ["assistant", sellerId] });
    const recent = new Set<string>();
    const subscription = client
      .channel(`crm-inbox-${sellerId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "inbox_conversations" },
        refreshInbox,
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "inbox_messages" },
        refreshInbox,
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "inbox_messages" },
        ({ new: message }) => {
          refreshInbox();
          if (
            message.direction !== "incoming" ||
            !message.provider_message_id ||
            recent.has(message.id)
          )
            return;
          if (recent.size >= 100)
            recent.delete(recent.values().next().value as string);
          recent.add(message.id);
          const channel = String(message.provider_message_id).split(":")[0];
          const label = channel === "instagram" ? "Instagram Direct" : channel === "messenger" ? "Messenger" : "WhatsApp";
          notify(`Nuevo mensaje de ${label}`, { type: "info" });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "assistant_states" },
        refreshAssistant,
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "assistant_decisions" },
        ({ new: decision }) => {
          refreshAssistant();
          refreshInbox();
          if (decision.requires_attention) {
            notify("Una conversación requiere atención de un asesor", {
              type: "info",
            });
          }
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          refreshInbox();
          refreshAssistant();
        }
      });

    return () => {
      void client.removeChannel(subscription);
    };
  }, [sellerId, notify, queryClient]);

  return null;
}
