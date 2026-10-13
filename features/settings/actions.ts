"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { canAdminister, requireContext } from "@/lib/data/context";
import { parseAiSettingsInput, parseDailyBudget } from "./ai-schema";
import { requireAal2 } from "@/lib/auth/require-aal2";
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
 * Switches AI assistance on or off for the organisation (owner or admin). The consent box is checked here as well as in
 * the form; the database then checks the role, the authenticator requirement, the daily budget and the rate limit, and
 * writes the audit row. Nothing is sent to a model until this is on and the deployment allows it (AI_ENABLED).
 */
export async function setAiSettings(input: { enabled: boolean; webResearch: boolean; consent: boolean }): Promise<ActionResult> {
  const ctx = await requireContext();
  if (!canAdminister(ctx.role)) return { ok: false, error: "Only an owner or admin can change AI assistance" };
  const parsed = parseAiSettingsInput(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("set_ai_settings", { p_org: ctx.organisation.id, p_enabled: parsed.enabled, p_web_research: parsed.webResearch });
  if (error) return { ok: false, error: toUserError(error, "Could not change AI assistance") };
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Sets the most the organisation's AI work may cost in one day (owner or admin). */
export async function setAiBudget(usd: number | string): Promise<ActionResult> {
  const ctx = await requireContext();
  if (!canAdminister(ctx.role)) return { ok: false, error: "Only an owner or admin can change the AI budget" };
  const parsed = parseDailyBudget(usd);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("set_ai_budget", { p_org: ctx.organisation.id, p_daily_usd: parsed.usd });
  if (error) return { ok: false, error: toUserError(error, "Could not change the AI budget") };
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
  const verify = await requireAal2(ctx);
  if (verify) return { ok: false, error: verify };
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
