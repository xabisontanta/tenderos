import { describe, expect, it } from "vitest";
import { MAX_APPLY_DOCUMENTS, applyReportSchema, buildApplyPlan, resolvePortalUrl, type ApplyPlanInput } from "@/lib/autofill/apply-plan";
import { toAutofillProfile, type AutofillDocument } from "@/lib/autofill/format";
import { DOCUMENT_TYPES, canReadDocumentType } from "@/lib/domain/documents";
import { parseApplyPlan } from "@/extension/src/plan.js";
import { SENSITIVE_DOC_TYPES } from "@/extension/src/match.js";

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const tender = (over: Partial<ApplyPlanInput["tender"]> = {}): ApplyPlanInput["tender"] => ({
  id: UUID(1),
  title: "Supply of office furniture",
  reference_number: "RFQ 2026/14",
  issuing_organisation: "City of Example",
  closing_at: "2026-10-30T10:00:00.000Z",
  submission_method: "ELECTRONIC_PORTAL",
  submission_destination: "https://www.etenders.gov.za (eSubmission)",
  source_url: "https://www.etenders.gov.za/home/Download?blobName=abc.pdf&downloadedFileName=Bid.pdf",
  ...over,
});

const doc = (n: number, doc_type: string, over: Partial<AutofillDocument> = {}): AutofillDocument => ({
  id: UUID(n),
  doc_type,
  title: `${doc_type} title`,
  file_name: `${doc_type}.pdf`,
  mime_type: "application/pdf",
  size_bytes: 1000,
  expires_at: null,
  ...over,
});

function input(over: Partial<ApplyPlanInput> = {}): ApplyPlanInput {
  return {
    tender: tender(),
    submissionId: UUID(2),
    organisationName: "Acme Trading (Pty) Ltd",
    role: "admin",
    profile: toAutofillProfile({ legal_name: "Acme Trading (Pty) Ltd", bbbee_level: 2, csd_number: "MAAA0123456" }),
    attachments: [
      { key: "tax", label: "Tax compliance", document_id: UUID(10) },
      { key: "cipc", label: "CIPC registration", document_id: UUID(11) },
    ],
    allowedDocuments: [doc(10, "tax_compliance"), doc(11, "cipc_registration"), doc(12, "csd_registration")],
    includeSensitive: false,
    allowLocalhost: false,
    now: new Date("2026-10-11T08:00:00.000Z"),
    ...over,
  };
}

function built(over: Partial<ApplyPlanInput> = {}) {
  const r = buildApplyPlan(input(over));
  if (!r.ok) throw new Error(`plan not built: ${r.reason}`);
  return r.plan;
}

describe("resolvePortalUrl", () => {
  const opts = { allowLocalhost: false };

  it("reads the web address out of an eTenders destination", () => {
    expect(resolvePortalUrl(tender(), opts)).toEqual({ ok: true, url: "https://www.etenders.gov.za/", host: "www.etenders.gov.za" });
  });

  it("takes a bare address and drops trailing punctuation and the fragment", () => {
    const r = resolvePortalUrl(tender({ submission_destination: "Submit at https://tenders.example.org.za/bids/submit#top)." }), opts);
    expect(r).toEqual({ ok: true, url: "https://tenders.example.org.za/bids/submit", host: "tenders.example.org.za" });
  });

  it("falls back to the tender notice address when the destination names no address", () => {
    const r = resolvePortalUrl(tender({ submission_destination: null, source_url: "https://portal.example.co.za/tender/42" }), opts);
    expect(r).toMatchObject({ ok: true, host: "portal.example.co.za" });
  });

  it("does not treat a document download link as a portal", () => {
    expect(resolvePortalUrl(tender({ submission_destination: null }), opts)).toEqual({ ok: false, reason: "no_portal_url" });
    expect(resolvePortalUrl(tender({ submission_destination: null, source_url: "https://example.gov.za/files/rfq.pdf" }), opts)).toEqual({
      ok: false,
      reason: "no_portal_url",
    });
  });

  it("refuses unsafe addresses and tenders that are not delivered through a portal", () => {
    for (const submission_destination of [
      "http://www.etenders.gov.za/",
      "https://user:pw@evil.example/",
      "https://10.0.0.5/portal",
      "javascript:alert(1)",
      "post it to the municipal offices",
    ]) {
      expect(resolvePortalUrl(tender({ submission_destination, source_url: null }), opts), submission_destination).toEqual({
        ok: false,
        reason: "no_portal_url",
      });
    }
    expect(resolvePortalUrl(tender({ submission_method: "EMAIL" }), opts)).toEqual({ ok: false, reason: "not_portal" });
    expect(resolvePortalUrl(tender({ submission_method: "PHYSICAL" }), opts)).toEqual({ ok: false, reason: "not_portal" });
  });

  it("allows localhost only when asked to (development)", () => {
    const t = tender({ submission_destination: "http://localhost:4000/portal", source_url: null });
    expect(resolvePortalUrl(t, opts)).toEqual({ ok: false, reason: "no_portal_url" });
    expect(resolvePortalUrl(t, { allowLocalhost: true })).toMatchObject({ ok: true, host: "localhost" });
  });
});

describe("buildApplyPlan", () => {
  it("builds a v1 plan with the portal, the facts and the bid pack documents", () => {
    const plan = built();
    expect(plan.version).toBe(1);
    expect(plan.portal).toEqual({ url: "https://www.etenders.gov.za/", host: "www.etenders.gov.za" });
    expect(plan.tender).toEqual({
      id: UUID(1),
      title: "Supply of office furniture",
      reference_number: "RFQ 2026/14",
      issuing_organisation: "City of Example",
      closing_at: "2026-10-30T10:00:00.000Z",
    });
    expect(plan.submission_id).toBe(UUID(2));
    expect(plan.member).toEqual({ role: "admin" });
    expect(plan.organisation).toEqual({ name: "Acme Trading (Pty) Ltd" });
    expect(plan.profile.legal_name).toBe("Acme Trading (Pty) Ltd");
    expect(plan.profile.vat_number).toBeNull();
    expect(plan.documents.map((d) => [d.id, d.label, d.sensitive])).toEqual([
      [UUID(10), "Tax compliance", false],
      [UUID(11), "CIPC registration", false],
    ]);
    expect(Object.keys(plan.documents[0]).sort()).toEqual(
      ["doc_type", "expires_at", "file_name", "id", "label", "mime_type", "size_bytes", "sensitive", "title"].sort(),
    );
    expect(plan.skipped_documents).toEqual([]);
    expect(plan.generated_at).toBe("2026-10-11T08:00:00.000Z");
  });

  it("attaches only documents of the approved bid pack, never other company documents", () => {
    expect(built().documents.map((d) => d.id)).not.toContain(UUID(12));
  });

  it("lists bid pack documents the helper cannot attach instead of dropping them silently", () => {
    const plan = built({ allowedDocuments: [doc(10, "tax_compliance")] });
    expect(plan.documents.map((d) => d.id)).toEqual([UUID(10)]);
    expect(plan.skipped_documents).toEqual([{ label: "CIPC registration", reason: "not_available" }]);
  });

  it("keeps personal documents out unless the person ticked the option, and only for owners and admins", () => {
    const attachments = [
      { key: "ids", label: "Director IDs", document_id: UUID(20) },
      { key: "bank", label: "Bank letter", document_id: UUID(21) },
      { key: "tax", label: "Tax compliance", document_id: UUID(10) },
    ];
    const allowedDocuments = [doc(20, "director_ids"), doc(21, "bank_confirmation"), doc(10, "tax_compliance")];

    const off = built({ attachments, allowedDocuments, includeSensitive: false });
    expect(off.include_sensitive).toBe(false);
    expect(off.documents.map((d) => d.id)).toEqual([UUID(10)]);
    expect(off.skipped_documents).toEqual([
      { label: "Director IDs", reason: "sensitive_not_requested" },
      { label: "Bank letter", reason: "sensitive_not_requested" },
    ]);

    const on = built({ attachments, allowedDocuments, includeSensitive: true });
    expect(on.include_sensitive).toBe(true);
    expect(on.documents.filter((d) => d.sensitive).map((d) => d.id)).toEqual([UUID(20), UUID(21)]);

    // An operator's request for personal documents is ignored; the database would not have returned them anyway.
    const operator = built({ attachments, allowedDocuments: [doc(10, "tax_compliance")], includeSensitive: true, role: "operator" });
    expect(operator.include_sensitive).toBe(false);
    expect(operator.documents.map((d) => d.id)).toEqual([UUID(10)]);
    expect(operator.skipped_documents.map((s) => s.reason)).toEqual(["not_available", "not_available"]);

    // Even if a sensitive document sneaked into the allowed list for an operator, it is not attached.
    const sneaky = built({ attachments, allowedDocuments, includeSensitive: true, role: "operator" });
    expect(sneaky.documents.some((d) => d.sensitive)).toBe(false);
  });

  it("counts a document once and stops at the cap", () => {
    const dup = built({ attachments: [input().attachments[0], input().attachments[0]] });
    expect(dup.documents).toHaveLength(1);

    const many = Array.from({ length: MAX_APPLY_DOCUMENTS + 5 }, (_, i) => doc(100 + i, "project_references"));
    const plan = built({
      attachments: many.map((d) => ({ key: "ref", label: d.title, document_id: d.id })),
      allowedDocuments: many,
    });
    expect(plan.documents).toHaveLength(MAX_APPLY_DOCUMENTS);
    expect(plan.skipped_documents).toHaveLength(5);
  });

  it("does not build a plan for a tender without a usable portal", () => {
    expect(buildApplyPlan(input({ tender: tender({ submission_method: "EMAIL" }) }))).toEqual({ ok: false, reason: "not_portal" });
    expect(buildApplyPlan(input({ tender: tender({ submission_destination: "hand delivery", source_url: null }) }))).toEqual({
      ok: false,
      reason: "no_portal_url",
    });
  });

  it("contains no storage paths, no signed links and no other organisation's data", () => {
    const text = JSON.stringify(built());
    expect(text).not.toMatch(/storage_path|signed|token|https:\/\/[^"]*supabase/i);
  });

  it("builds plans the extension accepts (contract test)", () => {
    const parsed = parseApplyPlan(JSON.parse(JSON.stringify(built())));
    expect(parsed.portal.host).toBe("www.etenders.gov.za");
    expect(parsed.documents.map((d) => d.id)).toEqual([UUID(10), UUID(11)]);
    expect(parsed.bid.attachments.map((a) => a.document_id)).toEqual([UUID(10), UUID(11)]);

    const withSensitive = built({
      attachments: [{ key: "ids", label: "Director IDs", document_id: UUID(20) }],
      allowedDocuments: [doc(20, "director_ids")],
      includeSensitive: true,
    });
    expect(parseApplyPlan(JSON.parse(JSON.stringify(withSensitive))).includeSensitive).toBe(true);
    const local = built({ tender: tender({ submission_destination: "http://localhost:4000/portal" }), allowLocalhost: true });
    expect(parseApplyPlan(JSON.parse(JSON.stringify(local)), { allowLocalhost: true }).portal.host).toBe("localhost");
  });
});

describe("sensitive document types", () => {
  it("are the same list in the extension and in the document vault rules", () => {
    const restricted = DOCUMENT_TYPES.filter((t) => !canReadDocumentType(t.key, false)).map((t) => t.key);
    expect([...SENSITIVE_DOC_TYPES].sort()).toEqual(restricted.sort());
  });
});

describe("applyReportSchema", () => {
  const ok = { host: "www.etenders.gov.za", fields: 12, documents: 3, left: 5, sensitive: false, confirmed_host: false };

  it("accepts counts and a host", () => {
    expect(applyReportSchema.safeParse(ok).success).toBe(true);
    expect(applyReportSchema.safeParse({ ...ok, fields: 0, documents: 0, left: 0 }).success).toBe(true);
  });

  it("refuses anything else, including field values or file names", () => {
    for (const bad of [
      { ...ok, host: "https://www.etenders.gov.za/" },
      { ...ok, host: "evil host" },
      { ...ok, fields: -1 },
      { ...ok, fields: 1.5 },
      { ...ok, fields: 100_000 },
      { ...ok, documents: MAX_APPLY_DOCUMENTS + 1 },
      { ...ok, sensitive: "yes" },
      { ...ok, values: { legal_name: "Acme" } },
      { ...ok, file_names: ["ids.pdf"] },
      { ...ok, host: undefined },
      null,
      "report",
    ]) {
      expect(applyReportSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
