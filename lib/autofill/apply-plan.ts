import { z } from "zod";
import { parsePortalUrl } from "@/extension/src/hosts.js";
import { canReadDocumentType } from "@/lib/domain/documents";
import type { AutofillDocument, AutofillProfile } from "./format";

/**
 * "Apply with TenderOS": the plan the browser helper fetches for one approved
 * bid (GET /api/autofill/tenders/<id>/apply-plan) and the report it sends
 * back (POST .../apply-report). Pure functions, unit-tested in
 * tests/unit/autofill-apply-plan.test.ts, which also checks that what is
 * built here is accepted by the extension's parser (extension/src/plan.js).
 */

export const APPLY_PLAN_VERSION = 1;

/** Most documents one apply attaches. */
export const MAX_APPLY_DOCUMENTS = 30;

export interface ApplyPlanDocument {
  id: string;
  doc_type: string;
  title: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  expires_at: string | null;
  /** The name the bid pack gives it (for example "SARS tax compliance status"). */
  label: string;
  /** Director IDs, bank letters and proof of address. */
  sensitive: boolean;
}

export interface ApplyPlanSkippedDocument {
  label: string;
  /** not_available: removed, expired, unverified or not allowed for this role. sensitive_not_requested: the person did not tick the option. */
  reason: "not_available" | "sensitive_not_requested";
}

export interface ApplyPlan {
  version: typeof APPLY_PLAN_VERSION;
  generated_at: string;
  organisation: { name: string };
  member: { role: string };
  tender: { id: string; title: string; reference_number: string | null; issuing_organisation: string; closing_at: string };
  submission_id: string;
  portal: { url: string; host: string };
  /** The company facts a portal form asks for; null where TenderOS holds nothing. */
  profile: AutofillProfile;
  include_sensitive: boolean;
  documents: ApplyPlanDocument[];
  skipped_documents: ApplyPlanSkippedDocument[];
}

export interface ApplyPlanTender {
  id: string;
  title: string;
  reference_number: string | null;
  issuing_organisation: string;
  closing_at: string;
  submission_method: string;
  submission_destination: string | null;
  source_url: string | null;
}

export interface ApplyPlanInput {
  tender: ApplyPlanTender;
  submissionId: string;
  organisationName: string;
  role: string;
  profile: AutofillProfile;
  /** The approved bid pack (the Submission Officer's `attachments`). */
  attachments: Array<{ key: string; label: string; document_id: string }>;
  /** Documents this member's role may attach right now (verified, in date, live). */
  allowedDocuments: AutofillDocument[];
  includeSensitive: boolean;
  /** Development builds only: a portal on http://localhost. */
  allowLocalhost: boolean;
  now: Date;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/gi;
const FILE_LINK = /\/download\b|\.(pdf|docx?|xlsx?|zip|rar|png|jpe?g)$/i;

/**
 * The web address of the portal a bid is delivered on, or why there is none.
 * Taken from the tender's submission destination (eTenders tenders say
 * "https://www.etenders.gov.za (eSubmission)"), else from the tender notice
 * address unless that is a file download. Only plain https addresses pass.
 */
export function resolvePortalUrl(
  tender: Pick<ApplyPlanTender, "submission_method" | "submission_destination" | "source_url">,
  options: { allowLocalhost: boolean },
): { ok: true; url: string; host: string } | { ok: false; reason: "not_portal" | "no_portal_url" } {
  if (tender.submission_method !== "ELECTRONIC_PORTAL") return { ok: false, reason: "not_portal" };
  const candidates: string[] = [];
  for (const m of (tender.submission_destination ?? "").matchAll(URL_IN_TEXT)) candidates.push(m[0].replace(/[).,;:!?]+$/, ""));
  if (tender.source_url) {
    let isFile = true;
    try {
      isFile = FILE_LINK.test(new URL(tender.source_url).pathname);
    } catch {
      isFile = true;
    }
    if (!isFile) candidates.push(tender.source_url);
  }
  for (const candidate of candidates) {
    const parsed = parsePortalUrl(candidate, { allowLocalhost: options.allowLocalhost });
    if (parsed.ok) return { ok: true, url: parsed.url, host: parsed.host };
  }
  return { ok: false, reason: "no_portal_url" };
}

/** Director IDs, bank letters and proof of address: the document types only owners and admins may open. */
export function isSensitiveDocType(docType: string): boolean {
  return !canReadDocumentType(docType, false);
}

/**
 * Builds the plan from what the server loaded. Attaches only documents of the
 * approved bid pack, never other company documents. Personal documents are
 * left out unless the member is an owner or admin and asked for them.
 */
export function buildApplyPlan(input: ApplyPlanInput): { ok: true; plan: ApplyPlan } | { ok: false; reason: "not_portal" | "no_portal_url" } {
  const portal = resolvePortalUrl(input.tender, { allowLocalhost: input.allowLocalhost });
  if (!portal.ok) return portal;

  const mayAttachSensitive = input.role === "owner" || input.role === "admin";
  const includeSensitive = input.includeSensitive && mayAttachSensitive;
  const allowed = new Map(input.allowedDocuments.map((d) => [d.id, d]));
  const documents: ApplyPlanDocument[] = [];
  const skipped: ApplyPlanSkippedDocument[] = [];
  const seen = new Set<string>();

  for (const a of input.attachments) {
    if (seen.has(a.document_id)) continue;
    seen.add(a.document_id);
    const d = allowed.get(a.document_id);
    if (!d || documents.length >= MAX_APPLY_DOCUMENTS) {
      skipped.push({ label: a.label, reason: "not_available" });
      continue;
    }
    const sensitive = isSensitiveDocType(d.doc_type);
    if (sensitive && !includeSensitive) {
      skipped.push({ label: a.label, reason: "sensitive_not_requested" });
      continue;
    }
    documents.push({
      id: d.id,
      doc_type: d.doc_type,
      title: d.title,
      file_name: d.file_name,
      mime_type: d.mime_type,
      size_bytes: d.size_bytes,
      expires_at: d.expires_at,
      label: a.label,
      sensitive,
    });
  }

  return {
    ok: true,
    plan: {
      version: APPLY_PLAN_VERSION,
      generated_at: input.now.toISOString(),
      organisation: { name: input.organisationName },
      member: { role: input.role },
      tender: {
        id: input.tender.id,
        title: input.tender.title,
        reference_number: input.tender.reference_number,
        issuing_organisation: input.tender.issuing_organisation,
        closing_at: new Date(input.tender.closing_at).toISOString(),
      },
      submission_id: input.submissionId,
      portal: { url: portal.url, host: portal.host },
      profile: input.profile,
      include_sensitive: includeSensitive,
      documents,
      skipped_documents: skipped,
    },
  };
}

/**
 * What the helper reports after it prepared a portal form: counts and the
 * host only. Never field values, file names or labels.
 */
export const applyReportSchema = z.strictObject({
  host: z
    .string()
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/),
  fields: z.number().int().min(0).max(500),
  documents: z.number().int().min(0).max(MAX_APPLY_DOCUMENTS),
  left: z.number().int().min(0).max(1000),
  /** The person chose to attach personal documents. */
  sensitive: z.boolean(),
  /** The person confirmed filling a site other than the portal TenderOS named. */
  confirmed_host: z.boolean(),
});
export type ApplyReport = z.infer<typeof applyReportSchema>;
