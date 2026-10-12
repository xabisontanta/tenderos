import { describe, expect, it } from "vitest";
import {
  STANDING_REMINDERS,
  buildConfirmModel,
  buildErrorModel,
  buildResultModel,
  buildWaitingModel,
  groupLeft,
  reportBody,
  statusMessage,
} from "@/extension/src/summary.js";
import type { FillSummary } from "@/extension/src/fill.js";

const summary = (over: Partial<FillSummary> = {}): FillSummary => ({
  page: "www.etenders.gov.za",
  tender: "Supply of office furniture",
  filled: [
    { label: "Registered company name", what: "Registered company name", check: false },
    { label: "Email", what: "Email", check: true },
  ],
  attached: [
    { label: "Tax compliance certificate", files: ["tcs.pdf"], ids: ["a"] },
    { label: "SARS tax clearance", files: ["tcs.pdf"], ids: ["a"] },
    { label: "CIPC certificate", files: ["cipc.pdf"], ids: ["b"] },
  ],
  left: [
    { label: "I declare that the information is true", code: "declaration", reason: "Declaration or consent. Read it and complete it yourself." },
    { label: "Signature", code: "signature", reason: "Signature. Sign it yourself." },
    { label: "Bid price", code: "price", reason: "Price or amount. Enter it yourself." },
    { label: "VAT number", code: "missing", reason: "Not in your TenderOS company profile." },
    { label: "Bank letter", code: "sensitive", reason: "Personal or banking document. Tick the option in the helper to attach it." },
    { label: "Mystery", code: "unmatched", reason: "Not recognised. Fill it in yourself." },
  ],
  unattached: [{ label: "COIDA letter", reason: "No upload field for this document was found on this page." }],
  at: "2026-10-11T08:00:00.000Z",
  ...over,
});

describe("groupLeft", () => {
  it("groups what is left for the person into plain categories in a fixed order", () => {
    const groups = groupLeft(summary().left, summary().unattached);
    expect(groups.map((g) => g.key)).toEqual(["declarations", "signatures", "prices", "documents", "missing", "other"]);
    expect(groups.find((g) => g.key === "declarations")?.items.map((i) => i.label)).toEqual(["I declare that the information is true"]);
    expect(groups.find((g) => g.key === "documents")?.items.map((i) => i.label)).toEqual(["Bank letter", "COIDA letter"]);
    expect(groups.find((g) => g.key === "other")?.items.map((i) => i.label)).toEqual(["Mystery"]);
  });

  it("omits empty groups", () => {
    expect(groupLeft([], [])).toEqual([]);
    expect(groupLeft([{ label: "x", code: "price", reason: "r" }], []).map((g) => g.key)).toEqual(["prices"]);
  });

  it("puts personal and sign-in fields with the things only the person can do", () => {
    const keys = groupLeft(
      [
        { label: "ID number", code: "id_number", reason: "r" },
        { label: "Security code", code: "captcha", reason: "r" },
        { label: "Password", code: "password", reason: "r" },
      ],
      [],
    ).map((g) => g.key);
    expect(keys).toEqual(["personal"]);
  });
});

describe("buildResultModel", () => {
  it("counts fields, distinct documents and what is left, and always carries the standing reminders", () => {
    const m = buildResultModel(summary(), { expectedHost: "www.etenders.gov.za", tabHost: "www.etenders.gov.za" });
    expect(m.mode).toBe("result");
    expect(m.counts).toEqual({ filled: 2, attached: 2, left: 7 });
    expect(m.headline).toBe("Prepared 2 fields and 2 documents for you to review");
    expect(m.filled[1]).toMatchObject({ label: "Email", check: true });
    expect(m.attached.map((a) => a.files)).toEqual([["tcs.pdf"], ["tcs.pdf"], ["cipc.pdf"]]);
    expect(m.reminders).toEqual(STANDING_REMINDERS);
    expect(m.reminders.join(" ")).toMatch(/submit/i);
    expect(m.reminders.join(" ")).toMatch(/declarations/i);
    expect(m.reminders.join(" ")).toMatch(/price/i);
    expect(m.reminders.join(" ")).toMatch(/signature|sign/i);
    expect(m.actions.map((a) => a.id)).toEqual(["refill", "close"]);
  });

  it("uses singular forms and a calm message when nothing could be filled", () => {
    const one = buildResultModel(summary({ filled: [summary().filled[0]], attached: [summary().attached[2]] }), {
      expectedHost: "a.gov.za",
      tabHost: "a.gov.za",
    });
    expect(one.headline).toBe("Prepared 1 field and 1 document for you to review");
    const none = buildResultModel(summary({ filled: [], attached: [], left: [], unattached: [] }), { expectedHost: "a.gov.za", tabHost: "a.gov.za" });
    expect(none.headline).toMatch(/nothing to fill on this page yet/i);
    expect(none.notes.join(" ")).toMatch(/sign in|open the form/i);
  });

  it("names a different site that the person confirmed", () => {
    const m = buildResultModel(summary(), { expectedHost: "www.etenders.gov.za", tabHost: "login.example.com", confirmed: true });
    expect(m.notes.join(" ")).toContain("login.example.com");
    expect(m.notes.join(" ")).toContain("www.etenders.gov.za");
  });

  it("lists documents that were skipped on purpose", () => {
    const m = buildResultModel(summary(), {
      expectedHost: "a.gov.za",
      tabHost: "a.gov.za",
      skipped: [{ label: "Director IDs", reason: "sensitive_not_requested" }],
    });
    expect(m.notes.join(" ")).toMatch(/Director IDs/);
    expect(m.notes.join(" ")).toMatch(/option/i);
  });
});

describe("other panel models", () => {
  it("asks for confirmation with both hosts named and offers fill or cancel", () => {
    const m = buildConfirmModel({ expectedHost: "www.etenders.gov.za", tabHost: "login.example.com", tender: "Furniture" });
    expect(m.mode).toBe("confirm");
    expect(m.headline).toContain("login.example.com");
    expect(m.headline).toContain("www.etenders.gov.za");
    expect(m.actions.map((a) => a.id)).toEqual(["confirm", "cancel"]);
    expect(m.actions[0].label).toContain("login.example.com");
  });

  it("explains waiting for the form", () => {
    const m = buildWaitingModel({ expectedHost: "www.etenders.gov.za", tender: "Furniture" });
    expect(m.mode).toBe("waiting");
    expect(m.notes.join(" ")).toMatch(/sign in/i);
    expect(m.actions.map((a) => a.id)).toEqual(["refill", "close"]);
  });

  it("shows an error with what to do next", () => {
    const m = buildErrorModel("TenderOS did not accept the pairing code.", "Connect the browser again in TenderOS Settings.");
    expect(m).toMatchObject({ mode: "error", headline: "TenderOS did not accept the pairing code." });
    expect(m.notes).toEqual(["Connect the browser again in TenderOS Settings."]);
    expect(m.actions.map((a) => a.id)).toEqual(["close"]);
  });
});

describe("reportBody", () => {
  it("sends the host and counts only", () => {
    const body = reportBody(summary(), { host: "www.etenders.gov.za", sensitive: false, confirmedHost: false });
    expect(body).toEqual({ host: "www.etenders.gov.za", fields: 2, documents: 2, left: 7, sensitive: false, confirmed_host: false });
    expect(JSON.stringify(body)).not.toMatch(/Acme|tcs\.pdf|Email/);
  });

  it("keeps counts inside what TenderOS accepts", () => {
    const many = Array.from({ length: 700 }, (_, i) => ({ label: `f${i}`, what: "x", check: false }));
    const b = reportBody(summary({ filled: many }), { host: "a.gov.za", sensitive: true, confirmedHost: true });
    expect(b.fields).toBe(500);
    expect(b).toMatchObject({ sensitive: true, confirmed_host: true });
  });
});

describe("statusMessage", () => {
  it("is a short plain sentence for the tender page", () => {
    expect(statusMessage(summary())).toBe("Prepared 2 fields and 2 documents on www.etenders.gov.za. Check everything, then submit it yourself.");
    expect(statusMessage(summary({ filled: [], attached: [] }))).toMatch(/nothing to fill/i);
  });
});
