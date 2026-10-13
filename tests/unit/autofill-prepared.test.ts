import { describe, expect, it } from "vitest";
import { describePrepared, parsePreparedEvent } from "@/lib/autofill/prepared";

const row = (over: Record<string, unknown> = {}) => ({
  created_at: "2026-10-11T08:15:00.000Z",
  event_type: "BID_FORM_PREPARED",
  payload: { host: "www.etenders.gov.za", fields: 12, documents: 3, left: 5, sensitive: false, confirmed_host: false },
  ...over,
});

describe("parsePreparedEvent", () => {
  it("reads the counts the helper reported", () => {
    expect(parsePreparedEvent(row())).toEqual({ at: "2026-10-11T08:15:00.000Z", host: "www.etenders.gov.za", fields: 12, documents: 3, left: 5 });
  });

  it("returns null for other events, missing rows and payloads of the wrong shape", () => {
    expect(parsePreparedEvent(null)).toBeNull();
    expect(parsePreparedEvent(row({ event_type: "SUBMISSION_COMPLETED" }))).toBeNull();
    expect(parsePreparedEvent(row({ payload: null }))).toBeNull();
    expect(parsePreparedEvent(row({ payload: "x" }))).toBeNull();
    expect(parsePreparedEvent(row({ payload: { host: 5, fields: "12" } }))).toBeNull();
    expect(parsePreparedEvent(row({ payload: { host: "a.gov.za", fields: -1, documents: 0, left: 0 } }))).toBeNull();
  });
});

describe("describePrepared", () => {
  it("says who prepared what, when, in South African time, and that the person submits", () => {
    const text = describePrepared({ at: "2026-10-11T08:15:00.000Z", host: "www.etenders.gov.za", fields: 12, documents: 3, left: 5 });
    expect(text).toContain("Prepared by TenderOS");
    expect(text).toContain("12 fields, 3 documents");
    expect(text).toContain("www.etenders.gov.za");
    expect(text).toMatch(/10:15/);
  });

  it("uses singular forms", () => {
    expect(describePrepared({ at: "2026-10-11T08:15:00.000Z", host: "a.gov.za", fields: 1, documents: 1, left: 0 })).toContain("1 field, 1 document");
  });
});
