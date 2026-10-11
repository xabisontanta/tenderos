import { describe, expect, it } from "vitest";
import { AUTH_SAMPLE_VARS, evaluateGoTemplate, previewEmails } from "@/emails/preview-data";

describe("evaluateGoTemplate", () => {
  const vars = { Email: "a@example.co.za", FactorType: "webauthn" };
  it("substitutes variables", () => expect(evaluateGoTemplate("Hi {{ .Email }}", vars)).toBe("Hi a@example.co.za"));
  it("follows if, else if and else", () => {
    const tpl = '{{ if eq .FactorType "totp" }}App{{ else if eq .FactorType "webauthn" }}Key{{ else }}{{ .FactorType }}{{ end }}';
    expect(evaluateGoTemplate(tpl, vars)).toBe("Key");
    expect(evaluateGoTemplate(tpl, { FactorType: "totp" })).toBe("App");
    expect(evaluateGoTemplate(tpl, { FactorType: "x" })).toBe("x");
  });
  it("fails loudly on a variable it does not know, the way a missing field would surface in Supabase", () => {
    expect(() => evaluateGoTemplate("{{ .Nope }}", vars)).toThrow(/Nope/);
  });
});

describe("previewEmails", () => {
  const emails = previewEmails({ now: new Date("2026-10-12T08:00:00+02:00") });
  it("lists every Supabase email and every app email with realistic data and no template syntax left", () => {
    expect(emails.filter((e) => e.group === "Supabase Auth")).toHaveLength(13);
    expect(emails.filter((e) => e.group === "Sent by TenderOS")).toHaveLength(5);
    for (const e of emails) {
      expect(e.html, e.id).not.toMatch(/\{\{/);
      expect(e.html, e.id).not.toContain("[object Object]");
      expect(e.subject.trim(), e.id).not.toBe("");
    }
  });
  it("uses an obviously fake code and addresses", () => {
    expect(AUTH_SAMPLE_VARS.Token).toMatch(/^\d{6}$/);
    expect(AUTH_SAMPLE_VARS.Email).toMatch(/@example\.co\.za$/);
  });
});
