import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNotify, useRefresh } from "ra-core";
import { Button } from "@/components/ui/button";
import { config } from "../root/config";
import type { Contact } from "../types";
import { setContactArchived } from "../providers/supabase/setContactArchived";

export function ContactArchiveButton({ contact }: { contact: Contact }) {
  const refresh = useRefresh();
  const notify = useNotify();
  const queryClient = useQueryClient();
  const archived = Boolean(contact.archived_at);
  const mutation = useMutation({
    mutationFn: () => setContactArchived(contact.id, !archived),
    onSuccess: async () => {
      refresh();
      await queryClient.invalidateQueries({ queryKey: ["inbox"] });
      notify(archived ? "Cliente restaurado" : "Cliente archivado", { type: "success" });
    },
    onError: () => notify("No se pudo cambiar el estado de archivo del cliente.", { type: "error" }),
  });

  if (!config.supabaseUrl) return null;

  return (
    <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
      {archived ? "Restaurar cliente" : "Archivar cliente"}
    </Button>
  );
}
