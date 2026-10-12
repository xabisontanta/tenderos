"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { requireContext } from "@/lib/data/context";
import { rateLimit, toUserError, type ActionResult } from "@/lib/actions";
import { createLogger } from "@/lib/log";
import { exportOrganisationData as readOrganisationExport } from "@/lib/privacy/erasure";

const log = createLogger({ service: "web.settings" });

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

/**
 * The organisation's data as one JSON file (POPIA access and portability). Owner only: it holds
 * every member's activity. Limited to three downloads an hour per person, and the database audits
 * each one (`popia.organisation_exported`, naming the owner). Credentials, pairing-code hashes and
 * file contents are never in it.
 */
export async function exportOrganisationData(): Promise<ActionResult<{ filename: string; json: string }>> {
  const ctx = await requireContext();
  if (ctx.role !== "owner") return { ok: false, error: "Only the owner can download the organisation's data" };
  const supabase = await getServerSupabase();
  const limited = await rateLimit(supabase, "org.export", 3, 3600);
  if (limited) return { ok: false, error: limited };
  try {
    const data = await readOrganisationExport(getAdminSupabase(), ctx.organisation.id, ctx.userId);
    log.info("organisation data exported", { organisation_id: ctx.organisation.id });
    return {
      ok: true,
      data: { filename: `tenderos-export-${ctx.organisation.slug}-${new Date().toISOString().slice(0, 10)}.json`, json: JSON.stringify(data, null, 2) },
    };
  } catch (err) {
    log.error("organisation data export failed", { organisation_id: ctx.organisation.id, error: (err as Error).message });
    return { ok: false, error: "Could not prepare the export. Try again in a few minutes." };
  }
}
