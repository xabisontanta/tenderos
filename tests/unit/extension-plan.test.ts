import { describe, expect, it } from "vitest";
import { HelperError } from "@/extension/src/errors.js";
import { parseApplyPlan } from "@/extension/src/plan.js";

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const PROFILE = {
  legal_name: "Acme Trading (Pty) Ltd",
  trading_name: null,
  registration_number: "2015/123456/07",
  csd_number: "MAAA0123456",
  vat_number: null,
  tax_pin: "ABC1234XYZ",
  tax_pin_expires_at: "2027-03-31",
  bbbee_level: 2,
  bbbee_expires_at: "2027-01-31",
  cidb_grade: null,
  authorised_signatory: "Thandi Mokoena",
  contact_person: "Sipho Ndlovu",
  contact_email: "tenders@acme.co.za",
  contact_phone: "082 555 0100",
  physical_address: "12 Main Road, Rosebank, Gauteng",
  postal_address: null,
  website: null,
};

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    generated_at: "2026-10-11T08:00:00.000Z",
    organisation: { name: "Acme Trading (Pty) Ltd" },
    member: { role: "admin" },
    tender: {
      id: UUID(1),
      title: "Supply of office furniture",
      reference_number: "RFQ 2026/14",
      issuing_organisation: "City of Example",
      closing_at: "2026-10-30T10:00:00.000Z",
    },
    submission_id: UUID(2),
    portal: { url: "https://www.etenders.gov.za/", host: "www.etenders.gov.za" },
    profile: PROFILE,
    include_sensitive: false,
    documents: [
      {
        id: UUID(3),
        doc_type: "tax_compliance",
        title: "TCS PIN letter",
        file_name: "tcs.pdf",
        mime_type: "application/pdf",
        size_bytes: 1200,
        expires_at: "2027-03-31",
        label: "Tax compliance",
        sensitive: false,
      },
    ],
    skipped_documents: [{ label: "Director IDs", reason: "sensitive_not_requested" }],
    ...overrides,
  };
}

function rejects(raw: unknown, options?: { allowLocalhost?: boolean }) {
  try {
    parseApplyPlan(raw, options);
  } catch (err) {
    expect(err).toBeInstanceOf(HelperError);
    return (err as HelperError).message;
  }
  throw new Error("expected the plan to be rejected");
}

describe("parseApplyPlan", () => {
  it("accepts a valid plan and builds the bid the field matcher uses", () => {
    const p = parseApplyPlan(plan());
    expect(p.portal).toMatchObject({ host: "www.etenders.gov.za", origin: "https://www.etenders.gov.za" });
    expect(p.documents.map((d) => d.id)).toEqual([UUID(3)]);
    expect(p.includeSensitive).toBe(false);
    expect(p.bid.tender).toMatchObject({ id: UUID(1), reference_number: "RFQ 2026/14", submission_method: "ELECTRONIC_PORTAL" });
    expect(p.bid.submission_id).toBe(UUID(2));
    expect(p.bid.attachments).toEqual([{ key: "tax_compliance", label: "Tax compliance", document_id: UUID(3), available: true }]);
    expect(p.profile.legal_name).toBe("Acme Trading (Pty) Ltd");
    expect(p.profile.bbbee_level).toBe(2);
    expect(p.skipped).toEqual([{ label: "Director IDs", reason: "sensitive_not_requested" }]);
  });

  it("fills missing profile keys with null and drops keys it does not know", () => {
    const { vat_number: _drop, ...partial } = PROFILE;
    const p = parseApplyPlan(plan({ profile: { ...partial, shoe_size: 42 } }));
    expect(p.profile.vat_number).toBeNull();
    expect("shoe_size" in p.profile).toBe(false);
  });

  it("refuses anything that is not a plan this helper understands", () => {
    for (const bad of [null, undefined, "plan", 7, []]) rejects(bad);
    expect(rejects(plan({ version: 2 }))).toMatch(/update the helper/i);
    expect(rejects(plan({ version: undefined }))).toMatch(/update the helper/i);
  });

  it("refuses a portal address that is not a plain https address", () => {
    for (const url of [
      "http://www.etenders.gov.za/",
      "javascript:alert(1)",
      "https://user:pw@www.etenders.gov.za/",
      "https://192.168.1.4/",
      "https://localhost/",
    ]) {
      expect(rejects(plan({ portal: { url, host: "www.etenders.gov.za" } })), url).toMatch(/portal address/i);
    }
  });

  it("refuses a portal whose declared host is not the host of its address", () => {
    expect(rejects(plan({ portal: { url: "https://www.etenders.gov.za/", host: "www.evil.example" } }))).toMatch(/portal address/i);
  });

  it("allows localhost portals only for builds that allow them", () => {
    const local = plan({ portal: { url: "http://localhost:4000/portal", host: "localhost" } });
    rejects(local);
    expect(parseApplyPlan(local, { allowLocalhost: true }).portal.host).toBe("localhost");
  });

  it("refuses malformed tender facts and ids", () => {
    rejects(plan({ tender: { ...(plan().tender as object), id: "not-a-uuid" } }));
    rejects(plan({ submission_id: "x" }));
    rejects(plan({ tender: { ...(plan().tender as object), title: "" } }));
    rejects(plan({ tender: { ...(plan().tender as object), closing_at: "tomorrow" } }));
  });

  it("refuses a profile value of the wrong kind", () => {
    rejects(plan({ profile: { ...PROFILE, legal_name: { evil: true } } }));
    rejects(plan({ profile: { ...PROFILE, legal_name: "x".repeat(3000) } }));
    rejects(plan({ profile: "nope" }));
  });

  it("validates every document", () => {
    const d = (plan().documents as Array<Record<string, unknown>>)[0];
    rejects(plan({ documents: [{ ...d, id: "nope" }] }));
    rejects(plan({ documents: [{ ...d, size_bytes: -1 }] }));
    rejects(plan({ documents: [{ ...d, size_bytes: 10 * 1024 * 1024 * 1024 }] }));
    rejects(plan({ documents: [{ ...d, file_name: "" }] }));
    rejects(plan({ documents: [{ ...d, sensitive: "no" }] }));
    rejects(plan({ documents: [d, d] }));
    rejects(plan({ documents: Array.from({ length: 31 }, (_, i) => ({ ...d, id: UUID(100 + i) })) }));
  });

  it("refuses a sensitive document the person did not ask to attach, even if the server sent it", () => {
    const sensitive = {
      id: UUID(4),
      doc_type: "director_ids",
      title: "Director IDs",
      file_name: "ids.pdf",
      mime_type: "application/pdf",
      size_bytes: 100,
      expires_at: null,
      label: "Director IDs",
      sensitive: true,
    };
    expect(rejects(plan({ documents: [sensitive], include_sensitive: false }))).toMatch(/personal documents/i);
    // A document of a sensitive type must also be flagged as sensitive.
    expect(rejects(plan({ documents: [{ ...sensitive, sensitive: false }], include_sensitive: true }))).toMatch(/personal documents/i);
    const ok = parseApplyPlan(plan({ documents: [sensitive], include_sensitive: true, skipped_documents: [] }));
    expect(ok.includeSensitive).toBe(true);
    expect(ok.documents[0].sensitive).toBe(true);
  });

  it("validates the skipped list", () => {
    rejects(plan({ skipped_documents: [{ label: "x", reason: "because" }] }));
    rejects(plan({ skipped_documents: "none" }));
  });

  it("never puts a value from the plan into the error message", () => {
    const msg = rejects(plan({ profile: { ...PROFILE, legal_name: { secret: "ACME-SECRET" }, tax_pin: "ABC1234XYZ" } }));
    expect(msg).not.toContain("ACME-SECRET");
    expect(msg).not.toContain("ABC1234XYZ");
  });
});
