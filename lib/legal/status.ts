import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export interface PendingDocument {
  kind: "terms" | "privacy";
  version: string;
}

/**
 * The documents now in force that this user has not accepted, empty when they
 * are up to date. Throws if the check itself fails: a user is never let through
 * on the strength of an error.
 */
export async function pendingLegalAcceptances(supabase: SupabaseClient<Database>): Promise<PendingDocument[]> {
  const { data, error } = await supabase.rpc("pending_legal_acceptances");
  if (error) throw new Error("Could not check which legal documents you have accepted");
  return (data ?? []) as PendingDocument[];
}
