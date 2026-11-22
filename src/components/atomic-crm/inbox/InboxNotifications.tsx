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
    const refreshInbox = () => void queryClient.invalidateQueries({ queryKey: ["inbox", sellerId] });
    const recent = new Set<string>();
    const subscription = client
      .channel(`crm-inbox-${sellerId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "inbox_conversations" }, refreshInbox)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "inbox_messages" }, refreshInbox)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "inbox_messages" }, ({ new: message }) => {
        refreshInbox();
        if (message.direction !== "incoming" || !message.provider_message_id || recent.has(message.id)) return;
        if (recent.size >= 100) recent.delete(recent.values().next().value as string);
        recent.add(message.id);
        notify("Nuevo mensaje de WhatsApp", { type: "info" });
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") refreshInbox();
      });

    return () => {
      void client.removeChannel(subscription);
    };
  }, [sellerId, notify, queryClient]);

  return null;
}
