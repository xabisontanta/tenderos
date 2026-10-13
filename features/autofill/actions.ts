"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { hashAutofillToken } from "@/lib/autofill/format";
import { canOperate, requireContext } from "@/lib/data/context";
import { requireAal2 } from "@/lib/auth/require-aal2";
import { toUserError, type ActionResult } from "@/lib/actions";

const labelSchema = z.string().trim().max(60, "Keep the name under 60 characters");

/**
 * Creates a pairing code for the browser helper. The plaintext code is
 * returned once, to show the member; only its hash is stored.
 */
export async function createAutofillToken(label: string): Promise<ActionResult<{ token: string }>> {
  const ctx = await requireContext();
  if (!canOperate(ctx.role)) return { ok: false, error: "Only owners, admins and operators can pair the browser helper" };
  const verify = await requireAal2(ctx);
  if (verify) return { ok: false, error: verify };
  const parsed = labelSchema.safeParse(label ?? "");
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const supabase = await getServerSupabase();
  const { data, error } = await supabase.rpc("create_autofill_token", { p_org: ctx.organisation.id, p_label: parsed.data || undefined });
  if (error || !data) return { ok: false, error: toUserError(error, "Could not create a pairing code") };
  revalidatePath("/settings");
  return { ok: true, data: { token: data } };
}

/**
 * Zero-copy pairing: creates a pairing code for the member's own browser. The
 * page passes it straight to the browser helper (window.postMessage to this
 * origin) and never shows, copies, logs or puts it in a URL. The id of the
 * code's row comes back with it so the page can match "this browser" to the
 * list below and revoke the code if the helper does not take it.
 */
export async function createBrowserPairing(label: string): Promise<ActionResult<{ token: string; tokenId: string }>> {
  const ctx = await requireContext();
  if (!canOperate(ctx.role)) return { ok: false, error: "Only owners, admins and operators can pair the browser helper" };
  const verify = await requireAal2(ctx);
  if (verify) return { ok: false, error: verify };
  const parsed = labelSchema.safeParse(label ?? "");
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const supabase = await getServerSupabase();
  const { data: token, error } = await supabase.rpc("create_autofill_token", { p_org: ctx.organisation.id, p_label: parsed.data || "Connected browser" });
  if (error || !token) return { ok: false, error: toUserError(error, "Could not connect the browser") };
  // The browser cannot read token hashes, so the row id is looked up here, scoped to this member.
  const { data: row } = await getAdminSupabase()
    .from("autofill_tokens")
    .select("id")
    .eq("token_hash", hashAutofillToken(token))
    .eq("organisation_id", ctx.organisation.id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  revalidatePath("/settings");
  if (!row) return { ok: false, error: "The pairing was created but could not be finished. Revoke the new entry in the list below and try again." };
  return { ok: true, data: { token, tokenId: row.id } };
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
