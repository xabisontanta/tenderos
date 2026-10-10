"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { requireContext } from "@/lib/data/context";
import { toUserError, type ActionResult } from "@/lib/actions";
import { tenderInputSchema } from "./schema";
import { USER_SETTABLE_STATUSES } from "@/lib/domain/tender-state";

export interface TenderFormState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

/** Converts a datetime-local value entered in SAST to an ISO string. */
function sast(v: FormDataEntryValue | null): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  if (/([zZ]|[+-]\d\d:\d\d)$/.test(s)) return s;
  return /T\d\d:\d\d:\d\d/.test(s) ? `${s}+02:00` : `${s}:00+02:00`;
}

export async function createTender(_: TenderFormState, formData: FormData): Promise<TenderFormState> {
  const ctx = await requireContext();
  const raw = {
    title: formData.get("title") ?? "",
    issuing_organisation: formData.get("issuing_organisation") ?? "",
    reference_number: formData.get("reference_number") ?? "",
    description: formData.get("description") ?? "",
    province: formData.get("province") ?? "UNKNOWN",
    sector: formData.get("sector") ?? "",
    estimated_value_zar: formData.get("estimated_value_zar") ?? "",
    published_at: sast(formData.get("published_at")),
    closing_at: sast(formData.get("closing_at")),
    briefing_at: sast(formData.get("briefing_at")),
    briefing_compulsory: formData.get("briefing_compulsory") === "on",
    briefing_location: formData.get("briefing_location") ?? "",
    questions_deadline_at: sast(formData.get("questions_deadline_at")),
    submission_method: formData.get("submission_method") ?? "UNKNOWN",
    submission_destination: formData.get("submission_destination") ?? "",
    source_url: formData.get("source_url") ?? "",
    is_simulation: formData.get("is_simulation") === "on",
  };
  const parsed = tenderInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) fieldErrors[String(i.path[0])] ??= i.message;
    return { error: "Please correct the highlighted fields", fieldErrors };
  }
  const supabase = await getServerSupabase();

  const { data, error } = await supabase
    .from("tenders")
    .insert({ ...parsed.data, organisation_id: ctx.organisation.id })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return { error: "A tender with this reference number already exists", fieldErrors: { reference_number: "Already exists" } };
    if (error.code === "42501") return { error: "You do not have permission to create tenders" };
    return { error: toUserError(error, "Could not create the tender") };
  }
  revalidatePath("/tenders");
  redirect(`/tenders/${data.id}`);
}

const uuid = z.string().uuid();

export async function startWorkflow(tenderId: string, options: { failStep?: string; failTimes?: number } = {}): Promise<ActionResult<string>> {
  if (!uuid.safeParse(tenderId).success) return { ok: false, error: "Invalid tender" };
  const opts = z
    .object({
      failStep: z.enum(["intake", "analysis", "qualification", "compliance", "proposal", "pricing", "qa", "submission"]).optional(),
      failTimes: z.number().int().min(1).max(10).optional(),
    })
    .safeParse(options);
  if (!opts.success) return { ok: false, error: "Invalid options" };
  const supabase = await getServerSupabase();
  const p_options = opts.data.failStep ? { fail_step: opts.data.failStep, fail_times: opts.data.failTimes ?? 1 } : {};
  const { data, error } = await supabase.rpc("start_tender_workflow", { p_tender_id: tenderId, p_options });
  if (error) return { ok: false, error: toUserError(error, "Could not start the workflow") };
  revalidatePath(`/tenders/${tenderId}`);
  return { ok: true, data: data as string };
}

/** Prepares a bid again after the approver sent it back or QA failed it, starting with a fresh compliance check. */
export async function rerunBid(tenderId: string): Promise<ActionResult<string>> {
  if (!uuid.safeParse(tenderId).success) return { ok: false, error: "Invalid tender" };
  const supabase = await getServerSupabase();
  const { data, error } = await supabase.rpc("rerun_bid", { p_tender_id: tenderId });
  if (error) return { ok: false, error: toUserError(error, "Could not restart the bid") };
  revalidatePath(`/tenders/${tenderId}`);
  return { ok: true, data: data as string };
}

export async function cancelWorkflow(runId: string, reason: string): Promise<ActionResult> {
  if (!uuid.safeParse(runId).success) return { ok: false, error: "Invalid workflow" };
  const r = z.string().trim().min(3, "Give a reason").max(500).safeParse(reason);
  if (!r.success) return { ok: false, error: r.error.issues[0].message };
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("cancel_workflow", { p_run_id: runId, p_reason: r.data });
  if (error) return { ok: false, error: toUserError(error, "Could not cancel the workflow") };
  return { ok: true };
}

export async function retryTask(taskId: string): Promise<ActionResult> {
  if (!uuid.safeParse(taskId).success) return { ok: false, error: "Invalid task" };
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("retry_task", { p_task_id: taskId });
  if (error) return { ok: false, error: toUserError(error, "Could not retry the task") };
  return { ok: true };
}

export async function transitionTender(tenderId: string, to: string, reason: string): Promise<ActionResult> {
  if (!uuid.safeParse(tenderId).success) return { ok: false, error: "Invalid tender" };
  const target = z.enum(USER_SETTABLE_STATUSES as unknown as [string, ...string[]]).safeParse(to);
  if (!target.success) return { ok: false, error: "That status can only be set by the workflow" };
  const r = z.string().trim().min(3, "Give a reason").max(500).safeParse(reason);
  if (!r.success) return { ok: false, error: r.error.issues[0].message };
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("transition_tender", { p_tender_id: tenderId, p_to: target.data as never, p_reason: r.data });
  if (error) return { ok: false, error: toUserError(error, "Could not change the status") };
  revalidatePath(`/tenders/${tenderId}`);
  return { ok: true };
}
