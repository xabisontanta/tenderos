"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { requireContext } from "@/lib/data/context";
import { toUserError, type ActionResult } from "@/lib/actions";
import { ORG_ROLES } from "@/lib/team/roles";

const idSchema = z.string().uuid("Choose a member");
const roleSchema = z.enum(ORG_ROLES as unknown as [string, ...string[]], { error: "Choose a role" });

/**
 * Changes a member's role. The database decides who may (owners and admins, with owners alone granting
 * owner or admin) and refuses to leave the organisation without an owner; its messages are written for
 * people and are shown as they are.
 */
export async function changeMemberRole(userId: string, role: string): Promise<ActionResult> {
  const ctx = await requireContext();
  const id = idSchema.safeParse(userId);
  if (!id.success) return { ok: false, error: id.error.issues[0].message };
  const r = roleSchema.safeParse(role);
  if (!r.success) return { ok: false, error: r.error.issues[0].message };
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("change_member_role", { p_org: ctx.organisation.id, p_user: id.data, p_role: r.data as (typeof ORG_ROLES)[number] });
  if (error) return { ok: false, error: toUserError(error, "Could not change the role") };
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Removes a member, or lets the caller leave when the id is their own. */
export async function removeMember(userId: string): Promise<ActionResult<{ left: boolean }>> {
  const ctx = await requireContext();
  const id = idSchema.safeParse(userId);
  if (!id.success) return { ok: false, error: id.error.issues[0].message };
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("remove_member", { p_org: ctx.organisation.id, p_user: id.data });
  if (error) return { ok: false, error: toUserError(error, "Could not remove the member") };
  revalidatePath("/", "layout");
  return { ok: true, data: { left: id.data === ctx.userId } };
}
