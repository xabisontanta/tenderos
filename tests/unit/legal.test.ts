import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DRAFT_NOTICE, PRIVACY_SECTIONS, TERMS_SECTIONS } from "@/lib/legal/content";
import { LEGAL_KINDS, LEGAL_VERSIONS } from "@/lib/legal/versions";

const overview = readFileSync("docs/legal/popia-overview.md", "utf8");

describe("legal document versions", () => {
  it("names one current version per kind", () => {
    expect(LEGAL_KINDS).toEqual(["terms", "privacy"]);
    for (const kind of LEGAL_KINDS) expect(LEGAL_VERSIONS[kind]).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/);
  });

  it("are the versions the consent migration marks as current", () => {
    // The integration test checks the database itself; this catches a bump made in only one place.
    const file = readdirSync("supabase/migrations").find((f) => f.endsWith("_legal_consent.sql"));
    expect(file, "the legal consent migration").toBeTruthy();
    const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
    for (const kind of LEGAL_KINDS) expect(sql).toContain(`('${kind}', '${LEGAL_VERSIONS[kind]}', true)`);
  });
});

describe("draft legal pages", () => {
  it("say plainly that they are an unreviewed draft", () => {
    expect(DRAFT_NOTICE).toMatch(/draft/i);
    expect(DRAFT_NOTICE).toMatch(/not legal advice/i);
    expect(DRAFT_NOTICE).toMatch(/attorney/i);
  });

  const covers = (sections: Array<{ heading: string }>, ...topics: RegExp[]) => topics.every((t) => sections.some((s) => t.test(s.heading)));

  it("terms cover the points the POPIA overview lists for the terms of service", () => {
    expect(
      covers(
        TERMS_SECTIONS,
        /acceptable use/i,
        /award/i,
        /human approval|approval/i,
        /artificial intelligence|AI/i,
        /liabilit/i,
        /terminat/i,
        /governing law/i,
      ),
    ).toBe(true);
  });

  it("privacy notice covers collection, purpose, recipients, transfers, rights, retention and the Information Officer", () => {
    expect(
      covers(
        PRIVACY_SECTIONS,
        /collect/i,
        /why|purpose/i,
        /who (receives|we share)|sub-processors/i,
        /outside south africa|cross-border/i,
        /your rights/i,
        /retention|how long/i,
        /information officer/i,
      ),
    ).toBe(true);
  });

  it("each section points at the row of the overview it was derived from, and has text", () => {
    for (const section of [...TERMS_SECTIONS, ...PRIVACY_SECTIONS]) {
      expect(section.body.length, section.heading).toBeGreaterThan(0);
      expect(section.body.every((p) => p.trim().length > 0)).toBe(true);
      expect(overview, `${section.heading}: overview row ${section.source}`).toMatch(new RegExp(`^\\| ${section.source} \\|`, "m"));
    }
  });

  it("do not state facts the project does not have", () => {
    const text = JSON.stringify([...TERMS_SECTIONS, ...PRIVACY_SECTIONS]);
    // No registration numbers, named officers or street addresses: those are for the attorney and the owner.
    expect(text).not.toMatch(/\b\d{4}\/\d{6}\/\d{2}\b/);
    expect(text).toMatch(/to be confirmed/i);
  });

  it("name the sub-processors the overview lists", () => {
    const text = PRIVACY_SECTIONS.flatMap((s) => s.body).join(" ");
    for (const name of ["Supabase", "Vercel", "Anthropic", "Google"]) expect(text).toContain(name);
  });
});
