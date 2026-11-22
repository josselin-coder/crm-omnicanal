import { HttpError, type Identifier } from "ra-core";
import { getSupabaseClient } from "./supabase";

export async function setContactArchived(id: Identifier, archived: boolean) {
  const { data, error } = await getSupabaseClient().rpc(
    "set_contact_archived",
    {
      target_id: id,
      archived,
    },
  );
  if (error || !data)
    throw new HttpError("Cannot change contact archive status", 403, error);
}
