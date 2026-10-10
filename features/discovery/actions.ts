"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { requireContext } from "@/lib/data/context";
import { toUserError, type ActionResult } from "@/lib/actions";
import { DELIVERY_METHODS, WATCHABLE_PROVINCES } from "./provinces";

const provincesSchema = z.array(z.enum(WATCHABLE_PROVINCES.map((p) => p.value) as [string, ...string[]])).max(10);
const methodsSchema = z
  .array(z.enum(DELIVERY_METHODS.map((m) => m.value) as [string, ...string[]]))
  .min(1, "Choose at least one way of delivering bids")
  .max(4);

/** Saves the watched provinces and delivery methods, and optionally starts a scan. */
export async function saveProvincesAndScan(provinces: string[], methods: string[], autoRun: boolean, scan: boolean): Promise<ActionResult> {
  const ctx = await requireContext();
  const parsed = provincesSchema.safeParse(provinces);
  if (!parsed.success) return { ok: false, error: "Unknown province" };
  const parsedMethods = methodsSchema.safeParse(methods);
  if (!parsedMethods.success) return { ok: false, error: parsedMethods.error.issues[0].message };
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("set_watched_provinces", { p_org: ctx.organisation.id, p_provinces: parsed.data, p_auto_run: autoRun });
  if (error) return { ok: false, error: toUserError(error, "Could not save provinces") };
  const { error: methodsError } = await supabase.rpc("set_watched_methods", { p_org: ctx.organisation.id, p_methods: parsedMethods.data });
  if (methodsError) return { ok: false, error: toUserError(methodsError, "Could not save delivery methods") };
  if (scan && parsed.data.length > 0) {
    const { error: scanError } = await supabase.rpc("start_discovery", { p_org: ctx.organisation.id, p_provinces: parsed.data });
    if (scanError) return { ok: false, error: toUserError(scanError, "Provinces saved, but the scan could not start") };
  }
  revalidatePath("/discover");
  return { ok: true };
}

export async function scanNow(): Promise<ActionResult> {
  const ctx = await requireContext();
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("start_discovery", { p_org: ctx.organisation.id });
  if (error) return { ok: false, error: toUserError(error, "Could not start the scan") };
  revalidatePath("/discover");
  return { ok: true };
}
