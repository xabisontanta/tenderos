import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { createLogger } from "@/lib/log";
import type { Database } from "@/types/database";
import {
  AUTOFILL_PROFILE_FIELDS,
  bearerToken,
  bidPackAttachments,
  hashAutofillToken,
  toAutofillProfile,
  type AutofillBid,
  type AutofillDocument,
  type AutofillPayload,
} from "./format";

type Admin = SupabaseClient<Database>;
type OrgRole = Database["public"]["Enums"]["org_role"];

export interface AutofillCaller {
  /** The pairing code's row id. Safe to log as `pairing_id`; the code itself never is. */
  tokenId: string;
  organisationId: string;
  userId: string;
  role: OrgRole;
}

export const log = createLogger({ service: "web.autofill" });

// No CORS headers on purpose: the extension's host permission lets it read
// these responses, and ordinary web pages must not be able to.
const BASE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Authorization" };

export function noStoreHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...BASE_HEADERS, ...extra };
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8", ...extra }) });
}

/** The same answer for a missing, malformed, unknown, revoked or expired code. */
export function unauthorized(): Response {
  return json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="tenderos-autofill"' });
}

/**
 * Authenticates a browser helper request by its pairing code and applies the
 * per-code rate limit. Returns the caller, or the response to send instead.
 */
export async function guardAutofill(
  req: Request,
  action: string,
  max: number,
  windowSeconds: number,
): Promise<{ admin: Admin; caller: AutofillCaller } | Response> {
  const token = bearerToken(req.headers.get("authorization"));
  if (!token) return unauthorized();
  const admin = getAdminSupabase();
  const { data, error } = await admin.rpc("resolve_autofill_token", { p_hash: hashAutofillToken(token) });
  if (error) {
    log.error("pairing code lookup failed", { code: error.code, message: error.message });
    return json({ error: "TenderOS could not check the pairing code. Try again shortly." }, 503);
  }
  const row = data?.[0];
  if (!row) return unauthorized();
  const caller: AutofillCaller = { tokenId: row.token_id, organisationId: row.organisation_id, userId: row.user_id, role: row.role };
  const { error: limitError } = await admin.rpc("hit_rate_limit_key", {
    p_key: `autofill_token:${caller.tokenId}`,
    p_action: action,
    p_max: max,
    p_window_seconds: windowSeconds,
  });
  if (limitError?.code === "P0429") return json({ error: "Too many requests; wait a minute and try again" }, 429, { "Retry-After": String(windowSeconds) });
  if (limitError) {
    log.error("autofill rate limit failed", { code: limitError.code, message: limitError.message, pairing_id: caller.tokenId });
    return json({ error: "TenderOS could not check the pairing code. Try again shortly." }, 503);
  }
  return { admin, caller };
}

function must<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data as T;
}

/**
 * What the helper may fill for this member: the company profile, the
 * documents their role may attach, and approved real bids waiting for a
 * person to deliver them. Values the organisation has not entered are null.
 */
export async function loadAutofillPayload(admin: Admin, caller: AutofillCaller, now = new Date()): Promise<AutofillPayload> {
  const org = caller.organisationId;
  const [orgRes, profileRes, docsRes, subsRes] = await Promise.all([
    admin.from("organisations").select("name").eq("id", org).single(),
    admin.from("company_profiles").select(AUTOFILL_PROFILE_FIELDS.join(",")).eq("organisation_id", org).maybeSingle(),
    admin.rpc("autofill_documents", { p_token_id: caller.tokenId }),
    admin
      .from("submission_records")
      .select("id, tender_id, workflow_run_id, approval_id")
      .eq("organisation_id", org)
      .eq("status", "ACTION_REQUIRED")
      .eq("is_simulation", false)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);
  const organisation = must(orgRes, "organisation");
  const profileRow = must(profileRes, "company profile") as unknown as Record<string, unknown> | null;
  const documents: AutofillDocument[] = (must(docsRes, "documents") ?? []).map((d) => ({
    id: d.id,
    doc_type: d.doc_type,
    title: d.title,
    file_name: d.file_name,
    mime_type: d.mime_type ?? null,
    size_bytes: d.size_bytes ?? null,
    expires_at: d.expires_at ?? null,
  }));
  const subs = must(subsRes, "submissions") ?? [];

  let bids: AutofillBid[] = [];
  if (subs.length) {
    const tenderIds = [...new Set(subs.map((s) => s.tender_id))];
    const runIds = [...new Set(subs.map((s) => s.workflow_run_id).filter((x): x is string => Boolean(x)))];
    const approvalIds = [...new Set(subs.map((s) => s.approval_id))];
    const [tendersRes, tasksRes, approvalsRes] = await Promise.all([
      admin
        .from("tenders")
        .select("id, title, reference_number, issuing_organisation, closing_at, submission_method, submission_destination, source_url")
        .eq("organisation_id", org)
        .in("id", tenderIds),
      runIds.length
        ? admin
            .from("tasks")
            .select("workflow_run_id, input, output, completed_at")
            .eq("organisation_id", org)
            .eq("type", "submission.execute")
            .eq("status", "COMPLETED")
            .in("workflow_run_id", runIds)
            .order("completed_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      admin.from("approvals").select("id, status").eq("organisation_id", org).in("id", approvalIds),
    ]);
    const tenders = new Map((must(tendersRes, "tenders") ?? []).map((t) => [t.id, t]));
    const tasks = must(tasksRes, "submission tasks") ?? [];
    const approved = new Set((must(approvalsRes, "approvals") ?? []).filter((a) => a.status === "APPROVED").map((a) => a.id));
    const allowed = new Set(documents.map((d) => d.id));

    bids = subs.flatMap((s): AutofillBid[] => {
      const t = tenders.get(s.tender_id);
      if (!t || !approved.has(s.approval_id) || new Date(t.closing_at).getTime() <= now.getTime()) return [];
      const task =
        tasks.find((k) => k.workflow_run_id === s.workflow_run_id && (k.input as Record<string, unknown> | null)?.approval_id === s.approval_id) ??
        tasks.find((k) => k.workflow_run_id === s.workflow_run_id);
      return [
        {
          submission_id: s.id,
          tender: {
            id: t.id,
            title: t.title,
            reference_number: t.reference_number,
            issuing_organisation: t.issuing_organisation,
            closing_at: t.closing_at,
            submission_method: t.submission_method,
            submission_destination: t.submission_destination,
            source_url: t.source_url,
          },
          attachments: bidPackAttachments(task?.output).map((a) => ({ ...a, available: allowed.has(a.document_id) })),
        },
      ];
    });
  }

  return {
    organisation: { name: organisation.name },
    member: { role: caller.role },
    profile: toAutofillProfile(profileRow),
    documents,
    bids,
    generated_at: now.toISOString(),
  };
}
