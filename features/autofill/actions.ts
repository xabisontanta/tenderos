"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { canOperate, requireContext } from "@/lib/data/context";
import { toUserError, type ActionResult } from "@/lib/actions";

const labelSchema = z.string().trim().max(60, "Keep the name under 60 characters");

/**
 * Creates a pairing code for the browser helper. The plaintext code is
 * returned once, to show the member; only its hash is stored.
 */
export async function createAutofillToken(label: string): Promise<ActionResult<{ token: string }>> {
  const ctx = await requireContext();
  if (!canOperate(ctx.role)) return { ok: false, error: "Only owners, admins and operators can pair the browser helper" };
  const parsed = labelSchema.safeParse(label ?? "");
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const supabase = await getServerSupabase();
  const { data, error } = await supabase.rpc("create_autofill_token", { p_org: ctx.organisation.id, p_label: parsed.data || undefined });
  if (error || !data) return { ok: false, error: toUserError(error, "Could not create a pairing code") };
  revalidatePath("/settings");
  return { ok: true, data: { token: data } };
}

/** Revokes a pairing code at once; the helper using it stops working. */
export async function revokeAutofillToken(id: string): Promise<ActionResult> {
  await requireContext();
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Invalid pairing code" };
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("revoke_autofill_token", { p_id: id });
  if (error) return { ok: false, error: toUserError(error, "Could not revoke the pairing code") };
  revalidatePath("/settings");
  return { ok: true };
}
