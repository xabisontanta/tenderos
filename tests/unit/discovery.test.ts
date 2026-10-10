import { describe, expect, it } from "vitest";
import { fetchOpenTenders, mapEtendersRow, provinceCode, saTime } from "@/agents/discovery/etenders";
import { evaluateCompliance, isComplete, profileEvidence } from "@/agents/compliance/logic";
import type { CompanyProfile } from "@/agents/runtime/types";
import { etendersFetcher, etendersRow, futureSaLocal } from "../fixtures/etenders";

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
    max_contract_value_zar: null,
    authorised_signatory: "A. Director",
  };

  it("passes when every mandatory item is in the profile", () => {
    const items = evaluateCompliance({ closing_at: closing, sector: "Services: Professional" }, profileEvidence(profile), new Date());
    expect(isComplete(items)).toBe(true);
    expect(items.find((i) => i.key === "csd_registration")?.evidence).toContain("MAAA0123456");
  });

  it("blocks on an expired tax PIN and on missing CIDB grading for construction", () => {
    const expired = { ...profile, tax_pin_expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) };
    const items = evaluateCompliance({ closing_at: closing, sector: "Civil engineering" }, profileEvidence(expired), new Date());
    expect(items.find((i) => i.key === "tax_compliance")?.status).toBe("EXPIRED");
    expect(items.find((i) => i.key === "cidb_grading")?.status).toBe("MISSING_INFORMATION");
    expect(isComplete(items)).toBe(false);
  });

  it("reports everything missing without a profile", () => {
    const items = evaluateCompliance({ closing_at: closing, sector: null }, profileEvidence(null), new Date());
    expect(items.every((i) => i.status === "MISSING_INFORMATION")).toBe(true);
  });
});
