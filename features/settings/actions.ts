"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { requireContext } from "@/lib/data/context";
import { toUserError, type ActionResult } from "@/lib/actions";

export async function setKillSwitch(engaged: boolean, reason: string): Promise<ActionResult> {
  const ctx = await requireContext();
  const r = z.string().trim().min(3, "Give a reason").max(300).safeParse(reason);
  if (!r.success) return { ok: false, error: r.error.issues[0].message };
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("set_kill_switch", { p_org: ctx.organisation.id, p_engaged: engaged, p_reason: r.data });
  if (error) return { ok: false, error: toUserError(error, "Could not change the kill switch") };
  revalidatePath("/", "layout");
  return { ok: true };
}
