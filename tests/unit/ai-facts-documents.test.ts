import { describe, expect, it } from "vitest";
import type { CompanyDocumentMeta, CompanyProfile } from "@/agents/runtime/types";
import type { DataCategory } from "@/agents/registry";
import { companyFacts, renderFacts } from "@/agents/runtime/ai/facts";
import { chunkDocument, prepareDocument, renderChunk } from "@/agents/runtime/ai/documents";
import { normaliseForMatch } from "@/agents/runtime/ai/guardrails/text";

const NOW = new Date("2026-10-10T10:00:00Z");

// Sentinel values: if any of these reaches a prompt, a test below fails.
const SENTINELS = {
  person: "Thabo Sentinel-Mokoena",
  email: "thabo.sentinel@example.test",
  phone: "082 555 0199",
  address: "14 Sentinel Street, Sandton",
  pin: "SENTINELPIN123",
  vat: "4999999999",
  reg: "2019/999999/07",
  csd: "MAAA9999999",
};

const profile = (o: Partial<CompanyProfile> = {}): CompanyProfile => ({
  organisation_id: "00000000-0000-0000-0000-0000000000aa",
  legal_name: "Umzansi Civils (Pty) Ltd",
  trading_name: "Umzansi Civils",
  registration_number: SENTINELS.reg,
  csd_number: SENTINELS.csd,
  tax_pin: SENTINELS.pin,
  tax_pin_expires_at: "2027-01-01",
  vat_number: SENTINELS.vat,
  bbbee_level: 2,
  bbbee_expires_at: "2027-03-01",
  cidb_grade: "6CE",
  sectors: ["Civil engineering", "Roads"],
  keywords: [],
  provinces: ["GAUTENG", "LIMPOPO"],
  max_contract_value_zar: 25_000_000,
  authorised_signatory: SENTINELS.person,
  contact_person: SENTINELS.person,
  contact_email: SENTINELS.email,
  contact_phone: SENTINELS.phone,
  physical_address: SENTINELS.address,
  postal_address: SENTINELS.address,
  website: "https://umzansi.example.test",
  ...o,
});

const doc = (o: Partial<CompanyDocumentMeta>): CompanyDocumentMeta => ({
  id: "d1",
  doc_type: "project_references",
  title: "Reference letter, Polokwane roads",
  file_name: "thabo-id-copy-SENTINEL.pdf",
  expires_at: null,
  verified: true,
  ...o,
});

const ALL = new Set<DataCategory>([
  "PUBLIC_TENDER_DATA",
  "TENDER_DOCUMENTS",
  "COMPANY_PROFILE",
  "COMPANY_CAPABILITIES",
  "PROJECT_REFERENCES",
  "CERTIFICATIONS",
  "INSURANCE",
  "PRICING",
]);

describe("company facts for prompts", () => {
  it("projects only an allow-list of company fields", () => {
    const text = JSON.stringify(companyFacts(profile(), [], ALL, NOW));
    for (const [name, value] of Object.entries(SENTINELS)) expect(text, name).not.toContain(value);
    expect(text).toContain("Umzansi Civils (Pty) Ltd");
    expect(text).toContain("6CE");
    expect(text).toContain("Civil engineering");
  });

  it("does not turn the exposure limit or website into prompt facts", () => {
    const text = JSON.stringify(companyFacts(profile(), [], ALL, NOW));
    expect(text).not.toContain("25000000");
    expect(text).not.toContain("umzansi.example.test");
  });

  it("only includes facts in categories the agent holds", () => {
    const profileOnly = companyFacts(profile(), [], new Set<DataCategory>(["COMPANY_PROFILE"]), NOW);
    expect(profileOnly.map((f) => f.id)).toContain("fact:cidb_grade");
    expect(profileOnly.map((f) => f.id)).not.toContain("fact:sectors");
    expect(companyFacts(profile(), [], new Set<DataCategory>(["PUBLIC_TENDER_DATA"]), NOW)).toEqual([]);
  });

  it("reads keywords and past experience when the profile has them", () => {
    const withExtras = {
      ...profile(),
      keywords: ["tarring", "kerbing"],
      past_experience: "Completed 12 km of municipal road rehabilitation in 2024.",
    } as CompanyProfile;
    const facts = companyFacts(withExtras, [], ALL, NOW);
    expect(facts.find((f) => f.id === "fact:keywords")?.value).toContain("tarring");
    expect(facts.find((f) => f.id === "fact:past_experience")?.value).toContain("12 km");
    expect(companyFacts(profile(), [], ALL, NOW).map((f) => f.id)).not.toContain("fact:past_experience");
  });

  it("includes only verified, in-date documents of capability categories, never file names", () => {
    const facts = companyFacts(
      null,
      [
        doc({ id: "ok" }),
        doc({ id: "unverified", verified: false }),
        doc({ id: "expired", doc_type: "cidb_grading", expires_at: "2026-10-01" }),
        doc({ id: "valid-cert", doc_type: "cidb_grading", title: "CIDB certificate 6CE", expires_at: "2027-06-30" }),
        doc({ id: "id-copy", doc_type: "director_ids", title: "Director ID" }),
        doc({ id: "bank", doc_type: "bank_confirmation", title: "Bank letter" }),
        doc({ id: "address", doc_type: "proof_of_address", title: "Utility bill" }),
        doc({ id: "tax", doc_type: "tax_compliance", title: "TCS" }),
      ],
      ALL,
      NOW,
    );
    expect(facts.map((f) => f.id).sort()).toEqual(["doc:ok", "doc:valid-cert"]);
    expect(JSON.stringify(facts)).not.toContain("SENTINEL");
  });

  it("drops restricted documents even when their category was somehow granted", () => {
    const granted = new Set<DataCategory>([...ALL, "DIRECTOR_PERSONAL", "BANKING", "PROOF_OF_ADDRESS"]);
    const facts = companyFacts(
      null,
      [doc({ id: "a", doc_type: "director_ids" }), doc({ id: "b", doc_type: "bank_confirmation" }), doc({ id: "c", doc_type: "proof_of_address" })],
      granted,
      NOW,
    );
    expect(facts).toEqual([]);
  });

  it("renders one citable line per fact", () => {
    const out = renderFacts(companyFacts(profile(), [], ALL, NOW));
    expect(out).toMatch(/^\[fact:legal_name\] .+Umzansi Civils \(Pty\) Ltd$/m);
    expect(out.split("\n").every((l) => l.startsWith("[fact:") || l.startsWith("[doc:"))).toBe(true);
  });

  it("removes identity numbers typed into free-text fields", () => {
    const facts = companyFacts(profile({ trading_name: "Mokoena 8001015009087 Trading" }), [], ALL, NOW);
    expect(JSON.stringify(facts)).not.toContain("8001015009087");
  });
});

describe("tender documents", () => {
  it("sanitises text and keeps page numbers in order", () => {
    const d = prepareDocument({
      id: "tender-1",
      title: 'Invitation <<<to>>> bid "2026"',
      pages: [
        { page: 2, text: "Second page <<< hostile" },
        { page: 1, text: "First page, contact ID 8001015009087" },
      ],
    });
    expect(d.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(JSON.stringify(d)).not.toMatch(/8001015009087|<<<|>>>/);
  });

  it("treats plain text as a single page-less block and PDF-only input as having no verifiable text", () => {
    const text = prepareDocument({ id: "a", title: "A", text: "Some text" });
    expect(text.pages).toEqual([{ page: null, text: "Some text" }]);
    const pdfOnly = prepareDocument({ id: "b", title: "B", pdfBase64: "JVBERi0xLjQ=" });
    expect(pdfOnly.pages).toEqual([]);
    expect(pdfOnly.pdfBase64).toBe("JVBERi0xLjQ=");
  });

  it("splits large documents into chunks that respect the limit and lose no text", () => {
    const pages = Array.from({ length: 6 }, (_, i) => ({ page: i + 1, text: `Page ${i + 1}. ` + "Bidders shall comply with the specification. ".repeat(40) }));
    const prepared = prepareDocument({ id: "big", title: "Big", pages });
    const chunks = chunkDocument(prepared, 3000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.pages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(3000);
    const rejoined = normaliseForMatch(chunks.flatMap((c) => c.pages.map((p) => p.text)).join(" "));
    expect(rejoined).toBe(normaliseForMatch(pages.map((p) => p.text).join(" ")));
    expect(chunks.map((c) => c.part)).toEqual(chunks.map((_, i) => i + 1));
    expect(new Set(chunks.map((c) => c.parts))).toEqual(new Set([chunks.length]));
  });

  it("splits one very long page-less text on paragraph boundaries", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. ` + "Delivery within the agreed period. ".repeat(10)).join("\n\n");
    const chunks = chunkDocument(prepareDocument({ id: "flat", title: "Flat", text }), 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.pages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(2000);
  });

  it("hard-splits a single paragraph longer than the limit", () => {
    const chunks = chunkDocument(prepareDocument({ id: "x", title: "X", text: "a".repeat(5000) }), 2000);
    expect(chunks.length).toBe(3);
  });

  it("renders page markers outside the text that quotes are checked against", () => {
    const [c] = chunkDocument(prepareDocument({ id: "d", title: "D", pages: [{ page: 3, text: "Clause text." }] }), 10_000);
    expect(renderChunk(c)).toBe("=== PAGE 3 ===\nClause text.");
  });
});
