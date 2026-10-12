import { z } from "zod";
import { WATCHABLE_PROVINCES } from "@/features/discovery/provinces";

/**
 * The part of the company profile that decides which tenders are relevant: sectors,
 * provinces, CIDB grade and keywords. The company page (actions.ts) and the setup
 * wizard (features/onboarding) both validate with this one definition, and the
 * database repeats the same rules as constraints (migrations 009 and 020).
 */

/** A text input from a form, or null when blank. */
export const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

/**
 * Turns the values of a list field into entries. Chips post one value each and a plain
 * text box posts one comma separated value; both come out the same. Entries are trimmed,
 * blanks dropped, and duplicates (ignoring case) removed, keeping the first spelling.
 */
export function parseList(values: Array<FormDataEntryValue | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const part of value.split(/[,\n]/)) {
      const entry = part.trim();
      const key = entry.toLowerCase();
      if (!entry || seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

export const MAX_SECTORS = 30;
export const MAX_KEYWORDS = 50;

export const cidbGradeSchema = z.string().regex(/^[1-9][A-Z]{1,3}$/, "Use the grade as printed, e.g. 5CE");
export const sectorsSchema = z
  .array(z.string().min(2, "Each sector needs at least 2 characters").max(120, "A sector can be at most 120 characters"))
  .max(MAX_SECTORS, `Choose at most ${MAX_SECTORS} sectors`);
export const provincesSchema = z.array(z.enum(WATCHABLE_PROVINCES.map((p) => p.value) as [string, ...string[]], "Choose provinces from the list"));
export const keywordsSchema = z
  .array(z.string().min(2, "Each keyword needs at least 2 characters").max(60, "A keyword can be at most 60 characters"))
  .max(MAX_KEYWORDS, `Use at most ${MAX_KEYWORDS} keywords`);

export const profileFocusShape = {
  cidb_grade: cidbGradeSchema.nullable(),
  sectors: sectorsSchema,
  provinces: provincesSchema,
  keywords: keywordsSchema,
};

export const profileFocusSchema = z.object(profileFocusShape);

/** Reads the four fields from a submitted form, ready for profileFocusSchema. */
export function readProfileFocus(formData: FormData) {
  return {
    cidb_grade: blank(formData.get("cidb_grade"))?.toUpperCase() ?? null,
    sectors: parseList(formData.getAll("sectors")),
    provinces: formData.getAll("provinces").map(String),
    keywords: parseList(formData.getAll("keywords")),
  };
}
