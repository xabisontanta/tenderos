import { describe, expect, it } from "vitest";
import { feedHealth, fetchOpenTenders, mapEtendersRow, maxInvalidRatioFromEnv, provinceCode, sanitizeText, saTime } from "@/agents/discovery/etenders";
import { documentEvidence, evaluateCompliance, isComplete, profileEvidence } from "@/agents/compliance/logic";
import type { CompanyProfile } from "@/agents/runtime/types";
import { etendersFetcher, etendersRow, futureSaLocal, nulRow, unreadableRows, untitledRow } from "../fixtures/etenders";

// Anything Postgres refuses in text or jsonb, plus the other control characters people paste in from Word and PDFs.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
// Half of a surrogate pair: valid in a JS string, refused by jsonb.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("eTenders connector", () => {
  it("maps province names from the portal", () => {
    expect(provinceCode("KwaZulu-Natal")).toBe("KWAZULU_NATAL");
    expect(provinceCode("North West")).toBe("NORTH_WEST");
    expect(provinceCode("Eastern Cape")).toBe("EASTERN_CAPE");
    expect(provinceCode("National")).toBe("NATIONAL");
    expect(provinceCode("Atlantis")).toBe("UNKNOWN");
    expect(provinceCode(null)).toBe("UNKNOWN");
  });

  it("reads portal times as South African time", () => {
    expect(saTime("2026-10-16T10:00:00")).toBe("2026-10-16T08:00:00.000Z");
    expect(saTime("0001-01-01T00:00:00")).toBeNull();
    expect(saTime(null)).toBeNull();
  });

  it("maps a row to a tender without inventing anything", () => {
    const m = mapEtendersRow(etendersRow() as never, new Date());
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.tender.title).toMatch(/^REQUEST FOR QUOTATION/);
    expect(m.tender.province).toBe("GAUTENG");
    expect(m.tender.reference_number).toBe("JTC0012/2026-27");
    expect(m.tender.submission_method).toBe("PHYSICAL");
    expect(m.tender.submission_destination).toContain("Sandton");
    expect(m.tender.documents[0].url).toContain("6dc689a4-3b9d-4f88-b3b2-59622eeb68c4.pdf");
    expect(m.tender.briefing_at).toBeNull();
  });

  it("skips closed tenders and marks eSubmission tenders", () => {
    expect(mapEtendersRow(etendersRow({ closing_Date: futureSaLocal(-1) }) as never, new Date())).toEqual({ ok: false, reason: "already closed" });
    const m = mapEtendersRow(etendersRow({ eSubmission: true }) as never, new Date());
    expect(m.ok && m.tender.submission_method).toBe("ELECTRONIC_PORTAL");
  });

  it("marks tenders delivered to a mailbox as email bids, and an @ in an address as physical", () => {
    const email = mapEtendersRow(etendersRow({ delivery: "Email to Tenders@Example.gov.za before closing" }) as never, new Date());
    expect(email.ok && [email.tender.submission_method, email.tender.submission_destination]).toEqual(["EMAIL", "tenders@example.gov.za"]);
    const address = mapEtendersRow(etendersRow({ delivery: "05 KENSINGTON BOULEVARD @ KINGSMEAD OFFICE, DURBAN" }) as never, new Date());
    expect(address.ok && address.tender.submission_method).toBe("PHYSICAL");
    const none = mapEtendersRow(etendersRow({ delivery: null }) as never, new Date());
    expect(none.ok && none.tender.submission_method).toBe("UNKNOWN");
  });

  it("pages through the feed until every row is read", async () => {
    const rows = Array.from({ length: 1100 }, (_, i) => etendersRow({ id: i }));
    const { fetcher, calls } = etendersFetcher(rows);
    let n = 0;
    for await (const page of fetchOpenTenders(fetcher)) n += page.rows.length;
    expect(n).toBe(1100);
    expect(calls).toHaveLength(3);
  });

  it("fails loudly when the portal errors", async () => {
    const gen = fetchOpenTenders(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(gen.next()).rejects.toThrow(/HTTP 503/);
  });
});

describe("eTenders connector: dirty input", () => {
  const read = async (rows: unknown[]) => {
    const pages: Array<{ rows: unknown[]; total: number; seen: number; unreadable: number; reasons: Record<string, number> }> = [];
    for await (const page of fetchOpenTenders(etendersFetcher(rows).fetcher)) pages.push(page);
    return pages;
  };

  it("strips NUL and other control characters, keeping line breaks in descriptions", () => {
    expect(sanitizeText("Pipes\u0000 and\u0007 valves\u001b[31m")).toBe("Pipes and valves[31m");
    expect(sanitizeText("line one\nline two\ttabbed")).toBe("line one\nline two\ttabbed");
    expect(sanitizeText("﻿BOM and zero​width")).toBe("BOM and zerowidth");
    expect(sanitizeText("lone \uD800 surrogate and a pair \u{1F600}")).toBe("lone  surrogate and a pair \u{1F600}");
  });

  it("leaves no control character in any text field, the contact details or the documents", () => {
    const m = mapEtendersRow(nulRow() as never, new Date());
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const everything = JSON.stringify(m.tender);
    expect(CONTROL.test(everything.replace(/\\n/g, " "))).toBe(false);
    // JSON.stringify would write NUL as \u0000, which jsonb refuses.
    expect(everything).not.toMatch(/\\u00(0[0-8bcBC]|1[0-9a-fA-F]|7f|[89][0-9a-fA-F])/);
    expect(m.tender.title).toBe("Supply of pipes");
    expect(m.tender.reference_number).toBe("NUL-1");
    expect(m.tender.issuing_organisation).toBe("Water Department");
    expect(m.tender.documents[0].name).toBe("spec.pdf");
    expect(m.tender.contact).toEqual({ person: "Pat", email: "pat@example.org", telephone: "011-1" });
  });

  it("falls back to the reference, then to the portal id, when the description gives no usable title", () => {
    const untitled = mapEtendersRow(untitledRow() as never, new Date());
    expect(untitled.ok && untitled.tender.title).toBe("eTenders 800002");
    const byReference = mapEtendersRow(untitledRow({ tender_No: "GT-2026-17" }) as never, new Date());
    expect(byReference.ok && byReference.tender.title).toBe("GT-2026-17");
    const shortReference = mapEtendersRow(untitledRow({ tender_No: "A1", description: "  \r\n\u0000 " }) as never, new Date());
    expect(shortReference.ok && shortReference.tender.title).toBe("eTenders 800002");
    const secondLine = mapEtendersRow(etendersRow({ description: "ab\r\nSupply of valves" }) as never, new Date());
    expect(secondLine.ok && secondLine.tender.title).toBe("Supply of valves");
  });

  it("always produces a title the database accepts (3 to 300 characters) and a reference of at most 120", () => {
    const messy = ["", " ", "\u0000", "N/A", "n/a", "ab", "\r\n\r\n", "x".repeat(5000), "\u{1F600}".repeat(400), "A\u0000B\u0000C"];
    for (const description of messy) {
      for (const tender_No of [...messy, null]) {
        const m = mapEtendersRow(etendersRow({ id: 7, description, tender_No }) as never, new Date());
        expect(m.ok, JSON.stringify({ description: description.slice(0, 10), tender_No })).toBe(true);
        if (!m.ok) continue;
        expect(m.tender.title.length).toBeGreaterThanOrEqual(3);
        expect(m.tender.title.length).toBeLessThanOrEqual(300);
        expect(CONTROL.test(m.tender.title)).toBe(false);
        expect(LONE_SURROGATE.test(m.tender.title), "a truncation must not split an emoji in half").toBe(false);
        expect((m.tender.reference_number ?? "x").length).toBeLessThanOrEqual(120);
      }
    }
  });

  it("falls back to the other organisation field when the first is empty, and reports what is missing", () => {
    const m = mapEtendersRow(etendersRow({ department: "", organ_of_State: "City of Tshwane" }) as never, new Date());
    expect(m.ok && m.tender.issuing_organisation).toBe("City of Tshwane");
    expect(mapEtendersRow(etendersRow({ department: null, organ_of_State: "" }) as never, new Date())).toEqual({
      ok: false,
      reason: "no issuing organisation",
    });
    expect(mapEtendersRow(etendersRow({ closing_Date: null }) as never, new Date())).toEqual({ ok: false, reason: "no closing date" });
  });

  it("counts rows it cannot read instead of dropping them silently or failing the page", async () => {
    const pages = await read([etendersRow({ id: 1 }), ...unreadableRows(), etendersRow({ id: 2 })]);
    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(page.seen).toBe(2 + unreadableRows().length);
    expect(page.unreadable).toBe(3); // an object id, a null id, a row that is not an object
    expect(page.rows).toHaveLength(page.seen - page.unreadable);
    expect(Object.keys(page.reasons).join("\n")).toMatch(/^id: /m);
    expect(Object.values(page.reasons).reduce((a, b) => a + b, 0)).toBe(page.unreadable);
  });

  it("tolerates harmless drift: numeric ids as text, numbers where text was, and a broken document list", async () => {
    const pages = await read([
      etendersRow({ id: "173690" }),
      etendersRow({ id: 5, closing_Date: 20261016, tender_No: 4711 }),
      etendersRow({ id: 6, supportDocument: "oops" }),
      etendersRow({ id: 7, province: { name: "Gauteng" } }),
    ]);
    expect(pages[0].unreadable).toBe(0);
    expect(pages[0].rows).toHaveLength(4);
    const mapped = pages[0].rows.map((r) => mapEtendersRow(r as never, new Date()));
    expect(mapped[0].ok && mapped[0].tender.source_ref).toBe("173690");
    expect(mapped[1]).toEqual({ ok: false, reason: "no closing date" }); // a number is not a time we can trust
    expect(mapped[2].ok && mapped[2].tender.documents).toEqual([]);
    expect(mapped[3].ok && mapped[3].tender.province).toBe("UNKNOWN");
  });

  it("does not report a closed tender as unreadable", () => {
    expect(mapEtendersRow(etendersRow({ closing_Date: futureSaLocal(-3) }) as never, new Date())).toEqual({ ok: false, reason: "already closed" });
  });
});

describe("feed health", () => {
  it("passes a feed with up to the allowed share of unreadable rows", () => {
    expect(feedHealth({ seen: 100, unreadable: 20, reasons: {} }, 0.2)).toEqual({ ok: true });
    expect(feedHealth({ seen: 0, unreadable: 0, reasons: {} }, 0.2)).toEqual({ ok: true });
    expect(feedHealth({ seen: 3, unreadable: 0, reasons: {} }, 0)).toEqual({ ok: true });
  });

  it("fails a feed above it, saying how many and why, so a scan never reports 0 matched for a feed it could not read", () => {
    const h = feedHealth({ seen: 100, unreadable: 21, reasons: { "id: expected a number": 18, "no closing date": 3 } }, 0.2);
    expect(h.ok).toBe(false);
    if (h.ok) return;
    expect(h.message).toMatch(/100 rows/);
    expect(h.message).toMatch(/21 \(21%\)/);
    expect(h.message).toMatch(/more than the 20% allowed/);
    expect(h.message).toMatch(/18 × id: expected a number/);
  });

  it("reads the allowed share from DISCOVERY_MAX_INVALID_PCT, with 20 percent as the default", () => {
    expect(maxInvalidRatioFromEnv({})).toBe(0.2);
    expect(maxInvalidRatioFromEnv({ DISCOVERY_MAX_INVALID_PCT: "35" })).toBe(0.35);
    expect(maxInvalidRatioFromEnv({ DISCOVERY_MAX_INVALID_PCT: "0" })).toBe(0);
    expect(maxInvalidRatioFromEnv({ DISCOVERY_MAX_INVALID_PCT: "100" })).toBe(1);
    for (const bad of ["", "abc", "-5", "150", "NaN"]) expect(maxInvalidRatioFromEnv({ DISCOVERY_MAX_INVALID_PCT: bad }), bad).toBe(0.2);
  });
});

describe("compliance from the company profile", () => {
  const closing = new Date(Date.now() + 20 * 86_400_000).toISOString();
  const profile: CompanyProfile = {
    organisation_id: "00000000-0000-0000-0000-000000000000",
    legal_name: "Example Trading (Pty) Ltd",
    registration_number: "2015/123456/07",
    csd_number: "MAAA0123456",
    tax_pin: "ABC123XYZ9",
    tax_pin_expires_at: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10),
    bbbee_level: 1,
    bbbee_expires_at: null,
    cidb_grade: null,
    sectors: [],
    provinces: [],
    keywords: [],
    max_contract_value_zar: null,
    authorised_signatory: "A. Director",
    trading_name: null,
    vat_number: null,
    contact_person: null,
    contact_email: null,
    contact_phone: null,
    physical_address: null,
    postal_address: null,
    website: null,
  };

  const doc = (doc_type: string, expires_at: string | null = null, verified = true) => ({
    id: `doc-${doc_type}`,
    doc_type,
    title: doc_type,
    file_name: `${doc_type}.pdf`,
    expires_at,
    verified,
  });

  it("never passes on typed-in profile facts alone", () => {
    const items = evaluateCompliance({ closing_at: closing, sector: "Services: Professional" }, profileEvidence(profile), new Date());
    expect(isComplete(items)).toBe(false);
    const csd = items.find((i) => i.key === "csd_registration")!;
    expect(csd.status).toBe("REQUIRES_CONFIRMATION");
    expect(csd.evidence).toContain("MAAA0123456");
    expect(csd.evidence).toContain("upload the document");
  });

  it("passes when every mandatory document is uploaded and verified, and prefers the upload over the profile", () => {
    const tcs = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    const uploads = documentEvidence([doc("cipc_registration"), doc("csd_registration"), doc("tax_compliance", tcs), doc("sbd_declarations")]);
    const items = evaluateCompliance({ closing_at: closing, sector: "Services: Professional" }, [...uploads, ...profileEvidence(profile)!], new Date());
    expect(isComplete(items)).toBe(true);
    expect(items.find((i) => i.key === "tax_compliance")?.document_id).toBe("doc-tax_compliance");
  });

  it("blocks on an expired tax document and on missing CIDB grading for construction", () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const uploads = documentEvidence([doc("cipc_registration"), doc("csd_registration"), doc("tax_compliance", soon), doc("sbd_declarations")]);
    const items = evaluateCompliance({ closing_at: closing, sector: "Civil engineering" }, uploads, new Date());
    expect(items.find((i) => i.key === "tax_compliance")?.status).toBe("EXPIRED");
    expect(items.find((i) => i.key === "cidb_grading")?.status).toBe("MISSING_INFORMATION");
    expect(isComplete(items)).toBe(false);
  });

  it("reports everything missing without a profile", () => {
    const items = evaluateCompliance({ closing_at: closing, sector: null }, profileEvidence(null), new Date());
    expect(items.every((i) => i.status === "MISSING_INFORMATION")).toBe(true);
  });
});
