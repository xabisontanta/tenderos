import { describe, expect, it } from "vitest";
import { parseList, profileFocusSchema, readProfileFocus } from "@/features/company/schema";

function form(entries: Array<[string, string]>) {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

describe("parseList", () => {
  it("splits on commas and new lines, trims, and drops blanks", () => {
    expect(parseList(["Civil engineering, Construction", "  Security services \n Cleaning ,, "])).toEqual([
      "Civil engineering",
      "Construction",
      "Security services",
      "Cleaning",
    ]);
  });

  it("removes duplicates ignoring case, keeping the first spelling", () => {
    expect(parseList(["Construction", "construction", "CONSTRUCTION, Catering"])).toEqual(["Construction", "Catering"]);
  });

  it("ignores files and missing values", () => {
    expect(parseList([null, new File(["x"], "x.txt"), "Catering"])).toEqual(["Catering"]);
  });
});

describe("readProfileFocus", () => {
  it("reads chips (one value each) and comma separated text the same way", () => {
    const chips = readProfileFocus(
      form([
        ["sectors", "Construction"],
        ["sectors", "Catering"],
        ["keywords", "road maintenance"],
        ["provinces", "GAUTENG"],
      ]),
    );
    const text = readProfileFocus(
      form([
        ["sectors", "Construction, Catering"],
        ["keywords", "road maintenance"],
        ["provinces", "GAUTENG"],
      ]),
    );
    expect(chips).toEqual(text);
    expect(chips).toEqual({ cidb_grade: null, sectors: ["Construction", "Catering"], provinces: ["GAUTENG"], keywords: ["road maintenance"] });
  });

  it("upper-cases the CIDB grade and treats blank as none", () => {
    expect(readProfileFocus(form([["cidb_grade", " 5ce "]])).cidb_grade).toBe("5CE");
    expect(readProfileFocus(form([["cidb_grade", "  "]])).cidb_grade).toBeNull();
    expect(readProfileFocus(form([])).cidb_grade).toBeNull();
  });
});

describe("profileFocusSchema", () => {
  const ok = { cidb_grade: "5CE", sectors: ["Construction"], provinces: ["GAUTENG", "NATIONAL"], keywords: ["road maintenance"] };

  it("accepts a normal profile and an empty one", () => {
    expect(profileFocusSchema.safeParse(ok).success).toBe(true);
    expect(profileFocusSchema.safeParse({ cidb_grade: null, sectors: [], provinces: [], keywords: [] }).success).toBe(true);
  });

  it.each(["0CE", "5", "5ce", "10CE", "5CEPE", "CE5", "5C E"])("rejects the CIDB grade %s", (grade) => {
    expect(profileFocusSchema.safeParse({ ...ok, cidb_grade: grade }).success).toBe(false);
  });

  it.each(["1A", "9GB", "3CE", "6SQ", "2EP"])("accepts the CIDB grade %s", (grade) => {
    expect(profileFocusSchema.safeParse({ ...ok, cidb_grade: grade }).success).toBe(true);
  });

  it("limits keywords to 50 of 2 to 60 characters each", () => {
    expect(profileFocusSchema.safeParse({ ...ok, keywords: Array.from({ length: 50 }, (_, i) => `keyword ${i}`) }).success).toBe(true);
    expect(profileFocusSchema.safeParse({ ...ok, keywords: Array.from({ length: 51 }, (_, i) => `keyword ${i}`) }).success).toBe(false);
    expect(profileFocusSchema.safeParse({ ...ok, keywords: ["a"] }).success).toBe(false);
    expect(profileFocusSchema.safeParse({ ...ok, keywords: ["ab"] }).success).toBe(true);
    expect(profileFocusSchema.safeParse({ ...ok, keywords: ["x".repeat(60)] }).success).toBe(true);
    expect(profileFocusSchema.safeParse({ ...ok, keywords: ["x".repeat(61)] }).success).toBe(false);
  });

  it("limits sectors to 30 of 2 to 120 characters each", () => {
    expect(profileFocusSchema.safeParse({ ...ok, sectors: Array.from({ length: 30 }, (_, i) => `Sector ${i}`) }).success).toBe(true);
    expect(profileFocusSchema.safeParse({ ...ok, sectors: Array.from({ length: 31 }, (_, i) => `Sector ${i}`) }).success).toBe(false);
    expect(profileFocusSchema.safeParse({ ...ok, sectors: ["x"] }).success).toBe(false);
    expect(profileFocusSchema.safeParse({ ...ok, sectors: ["x".repeat(121)] }).success).toBe(false);
  });

  it("rejects a province that cannot be watched", () => {
    expect(profileFocusSchema.safeParse({ ...ok, provinces: ["ATLANTIS"] }).success).toBe(false);
    expect(profileFocusSchema.safeParse({ ...ok, provinces: ["UNKNOWN"] }).success).toBe(false);
  });

  it("explains a problem in words the form can show", () => {
    const result = profileFocusSchema.safeParse({ ...ok, keywords: ["a"], cidb_grade: "x" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.join(" ")).toMatch(/keyword/i);
      expect(messages.join(" ")).toMatch(/5CE/);
    }
  });
});
