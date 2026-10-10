"use server";

import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/actions";

export async function markNotificationsRead(ids: string[]): Promise<ActionResult> {
  const parsed = z.array(z.string().uuid()).max(100).safeParse(ids);
  if (!parsed.success) return { ok: false, error: "Invalid request" };
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("mark_notifications_read", { p_ids: parsed.data });
  return error ? { ok: false, error: "Could not update notifications" } : { ok: true };
}
