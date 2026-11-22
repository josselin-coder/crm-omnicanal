import { useState } from "react";
import { useNotify } from "ra-core";
import { Button } from "@/components/ui/button";
import { config } from "../root/config";
import { getSupabaseClient } from "../providers/supabase/supabase";

type Attachment = {
  id: string;
  name: string;
  kind: string;
  mime: string | null;
  state: string;
};

export function MetaAttachment({ attachment }: { attachment: Attachment }) {
  const [loading, setLoading] = useState(false);
  const [image, setImage] = useState<string>();
  const notify = useNotify();
  const canPreview = /^image\/(jpeg|png|gif|webp)$/.test(attachment.mime ?? "");

  async function open(preview: boolean) {
    setLoading(true);
    try {
      const { data, error } = await getSupabaseClient().functions.invoke<{ path: string }>("meta-inbox", {
        body: { action: "attachment", attachmentId: attachment.id, preview },
      });
      if (error || !data?.path?.startsWith("/storage/v1/object/sign/meta-messaging-media/")) {
        throw new Error("Attachment is unavailable");
      }
      const url = new URL(data.path, config.supabaseUrl).href;
      if (preview) {
        setImage(url);
      } else {
        const link = document.createElement("a");
        link.href = url;
        link.rel = "noreferrer";
        link.click();
      }
    } catch {
      notify("No se pudo abrir el adjunto.", { type: "error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2 space-y-2">
      <p className="break-words text-sm">{attachment.name}</p>
      {attachment.state === "pending" && <p className="text-xs text-muted-foreground">Descarga pendiente</p>}
      {attachment.state === "unavailable" && <p className="text-xs text-muted-foreground">Adjunto no disponible</p>}
      {attachment.state === "ready" && (
        <div className="flex flex-wrap gap-2">
          {canPreview && (
            <Button size="sm" variant="outline" disabled={loading} onClick={() => void open(true)}>
              Ver imagen
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void open(false)}>
            Descargar
          </Button>
        </div>
      )}
      {image && <img src={image} alt={attachment.name} className="max-h-64 max-w-full rounded-md" />}
    </div>
  );
}
