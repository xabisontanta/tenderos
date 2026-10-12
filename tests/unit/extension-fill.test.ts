import { describe, expect, it, vi } from "vitest";
import { HelperError } from "@/extension/src/errors.js";
import { runFill, selectFrames, type FillDeps } from "@/extension/src/fill.js";
import type { FieldDescriptor, HelperBid, HelperDocument } from "@/extension/src/match.js";

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROFILE = {
  legal_name: "Acme Trading (Pty) Ltd",
  csd_number: "MAAA0123456",
  contact_email: "tenders@acme.co.za",
  bbbee_level: 2,
  bbbee_expires_at: "2027-01-31",
};

let next = 0;
const field = (d: Partial<FieldDescriptor>): FieldDescriptor => ({ index: next++, tag: "input", type: "text", ...d });
const doc = (n: number, doc_type: string, over: Partial<HelperDocument> = {}): HelperDocument => ({
  id: UUID(n),
  doc_type,
  title: `${doc_type} title`,
  file_name: `${doc_type}.pdf`,
  mime_type: "application/pdf",
  size_bytes: 1000,
  expires_at: null,
  ...over,
});

const frame = (frameId: number, fields: FieldDescriptor[], origin = "https://portal.example.gov.za") => ({ frameId, result: { origin, fields } });

function deps(over: Partial<FillDeps> = {}): FillDeps & { applied: Array<{ frameId: number; steps: unknown[]; files: Record<string, unknown> }> } {
  const applied: Array<{ frameId: number; steps: unknown[]; files: Record<string, unknown> }> = [];
  return {
    applied,
    applyFrame: async (frameId, steps, files) => {
      applied.push({ frameId, steps, files });
      return { done: (steps as Array<{ index: number }>).map((s) => s.index), failed: [] };
    },
    fetchDocument: async () => ({ base64: "JVBERi0=", size: 7, type: "application/pdf" }),
    ...over,
  };
}

const base = {
  profile: PROFILE,
  documents: [] as HelperDocument[],
  bid: null,
  today: "2026-10-11",
  includeSensitive: false,
  page: "portal.example.gov.za",
  expected: [],
};

describe("selectFrames", () => {
  it("keeps the top frame and same-origin frames only", () => {
    const top = frame(0, [field({ label: "Company name" })], "https://portal.example.gov.za");
    const same = frame(3, [], "https://portal.example.gov.za");
    const cross = frame(5, [], "https://ads.example.com");
    const nullOrigin = frame(6, [], "null");
    expect(selectFrames([top, same, cross, nullOrigin]).map((f) => f.frameId)).toEqual([0, 3]);
  });

  it("uses nothing when the top frame did not answer, because the origin cannot be confirmed", () => {
    expect(selectFrames([frame(3, [], "https://portal.example.gov.za")])).toEqual([]);
    expect(selectFrames([{ frameId: 0, result: null }, frame(3, [])])).toEqual([]);
  });
});

describe("runFill", () => {
  it("fills what it recognises and lists the rest with a reason and a code", async () => {
    const d = deps();
    const name = field({ label: "Registered company name" });
    const price = field({ label: "Total bid price (R)" });
    const agree = field({ label: "I declare that the information is true", type: "checkbox" });
    const summary = await runFill({ ...base, scans: [frame(0, [name, price, agree])], deps: d });

    expect(summary.filled).toEqual([{ label: "Registered company name", what: "Registered company name", check: false }]);
    expect(summary.left.map((l) => [l.label, l.code])).toEqual([
      ["Total bid price (R)", "price"],
      ["I declare that the information is true", "declaration"],
    ]);
    expect(summary.left[0].reason).toMatch(/enter it yourself/i);
    expect(summary.page).toBe("portal.example.gov.za");
    expect(d.applied).toHaveLength(1);
    expect(d.applied[0].steps).toEqual([expect.objectContaining({ index: name.index, action: "fill", value: "Acme Trading (Pty) Ltd" })]);
  });

  it("attaches documents once even when several fields want the same one, and reports the file names", async () => {
    const d = deps();
    const tax = doc(1, "tax_compliance");
    const a = field({ label: "Tax compliance certificate", type: "file" });
    const b = field({ label: "SARS tax clearance", type: "file" });
    const fetchDocument = vi.fn(d.fetchDocument);
    const summary = await runFill({ ...base, documents: [tax], scans: [frame(0, [a, b])], deps: { ...d, fetchDocument } });
    expect(fetchDocument).toHaveBeenCalledTimes(1);
    expect(summary.attached).toHaveLength(2);
    expect(summary.attached[0]).toEqual({ label: "Tax compliance certificate", files: ["tax_compliance.pdf"], ids: [tax.id] });
    expect(Object.keys(d.applied[0].files)).toEqual([tax.id]);
  });

  it("says which expected documents found no upload field", async () => {
    const d = deps();
    const tax = doc(1, "tax_compliance");
    const cipc = doc(2, "cipc_registration");
    const upload = field({ label: "Tax compliance certificate", type: "file" });
    const summary = await runFill({
      ...base,
      documents: [tax, cipc],
      expected: [
        { id: tax.id, label: "SARS tax compliance" },
        { id: cipc.id, label: "CIPC registration" },
      ],
      scans: [frame(0, [upload])],
      deps: d,
    });
    expect(summary.unattached).toEqual([{ label: "CIPC registration", reason: expect.stringMatching(/no upload field/i) }]);
  });

  it("lists a document TenderOS no longer serves as left for the person, with an actionable reason", async () => {
    const d = deps({
      fetchDocument: async () => {
        throw new HelperError("gone", "not_found");
      },
    });
    const tax = doc(1, "tax_compliance");
    const upload = field({ label: "Tax compliance certificate", type: "file" });
    const summary = await runFill({ ...base, documents: [tax], scans: [frame(0, [upload])], deps: d });
    expect(summary.attached).toEqual([]);
    expect(summary.left).toEqual([
      { label: "Tax compliance certificate", code: "doc_revoked", reason: expect.stringMatching(/no longer available in TenderOS/i) },
    ]);
    expect(d.applied.length === 0 || (d.applied[0].steps as unknown[]).length === 0).toBe(true);
  });

  it("stops everything when TenderOS stops accepting the pairing code", async () => {
    const d = deps({
      fetchDocument: async () => {
        throw new HelperError("TenderOS did not accept the pairing code.", "unauthorized");
      },
    });
    const upload = field({ label: "Tax compliance certificate", type: "file" });
    await expect(runFill({ ...base, documents: [doc(1, "tax_compliance")], scans: [frame(0, [upload])], deps: d })).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("does not try a download that would pass the size budget", async () => {
    const d = deps();
    const big = doc(1, "tax_compliance", { size_bytes: 30 * 1024 * 1024 });
    const big2 = doc(2, "cipc_registration", { size_bytes: 30 * 1024 * 1024 });
    const fetchDocument = vi.fn(async () => ({ base64: "x", size: 30 * 1024 * 1024, type: "application/pdf" }));
    const summary = await runFill({
      ...base,
      documents: [big, big2],
      scans: [frame(0, [field({ label: "Tax compliance certificate", type: "file" }), field({ label: "CIPC registration certificate", type: "file" })])],
      deps: { ...d, fetchDocument },
      maxBytes: 40 * 1024 * 1024,
    });
    expect(fetchDocument).toHaveBeenCalledTimes(1);
    expect(summary.attached).toHaveLength(1);
    expect(summary.left.map((l) => l.code)).toEqual(["too_large"]);
  });

  it("never touches a cross-origin frame", async () => {
    const d = deps();
    const mine = field({ label: "Registered company name" });
    const theirs = field({ label: "Registered company name" });
    const summary = await runFill({ ...base, scans: [frame(0, [mine]), frame(7, [theirs], "https://evil.example.com")], deps: d });
    expect(d.applied.map((a) => a.frameId)).toEqual([0]);
    expect(summary.filled).toHaveLength(1);
  });

  it("fills same-origin frames too, and reports a step the page changed as left", async () => {
    const nameTop = field({ label: "Registered company name" });
    const emailFrame = field({ label: "Email address" });
    const d = deps({
      applyFrame: async (frameId, steps) => {
        const s = steps as Array<{ index: number }>;
        if (frameId === 4) return { done: [], failed: s.map((x) => ({ index: x.index, reason: "changed" })) };
        return { done: s.map((x) => x.index), failed: [] };
      },
    });
    const summary = await runFill({ ...base, scans: [frame(0, [nameTop]), frame(4, [emailFrame])], deps: d });
    expect(summary.filled.map((f) => f.label)).toEqual(["Registered company name"]);
    expect(summary.left).toEqual([{ label: "Email address", code: "changed", reason: expect.stringMatching(/page changed/i) }]);
  });

  it("flags low-confidence fills for a second look", async () => {
    const d = deps();
    const f = field({ name: "contact_email", type: "text" });
    const summary = await runFill({ ...base, scans: [frame(0, [f])], deps: d });
    expect(summary.filled[0].check).toBe(true);
  });

  it("returns an empty summary when the page has no fields", async () => {
    const summary = await runFill({ ...base, scans: [frame(0, [])], deps: deps() });
    expect(summary).toMatchObject({ filled: [], attached: [], left: [], unattached: [] });
  });

  it("uses the tender number from the bid", async () => {
    const bid: HelperBid = {
      submission_id: UUID(9),
      tender: {
        id: UUID(8),
        title: "Furniture",
        reference_number: "RFQ 2026/14",
        issuing_organisation: "City",
        closing_at: "2026-10-30T10:00:00.000Z",
        submission_method: "ELECTRONIC_PORTAL",
        submission_destination: "https://portal.example.gov.za/",
        source_url: null,
      },
      attachments: [],
    };
    const d = deps();
    const summary = await runFill({ ...base, bid, scans: [frame(0, [field({ label: "Tender number" })])], deps: d });
    expect(summary.filled[0].what).toBe("Tender number");
    expect(summary.tender).toBe("Furniture");
  });
});
