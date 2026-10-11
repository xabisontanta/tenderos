import type { DataCategory } from "@/agents/registry";
import { documentType } from "@/lib/domain/documents";
import { endOfDaySast, provinceLabel } from "@/lib/format";
import { PROMPT_PROHIBITED_CATEGORIES } from "../permissions";
import type { CompanyDocumentMeta, CompanyProfile } from "../types";
import { sanitiseSourceText } from "./guardrails/text";

export interface CompanyFact {
  /** Stable id the model must cite, e.g. "fact:cidb_grade" or "doc:<uuid>". */
  id: string;
  label: string;
  value: string;
  category: DataCategory;
  /** The organisation typed profile facts in; documents are only listed once someone has verified them. */
  provenance: "COMPANY_PROFILE" | "VERIFIED_DOCUMENT";
}

/** Document categories that describe what the company can do. Tax, banking and identity documents are never facts for a prompt. */
const FACT_DOCUMENT_CATEGORIES: readonly DataCategory[] = ["CERTIFICATIONS", "PROJECT_REFERENCES", "COMPANY_CAPABILITIES", "INSURANCE"];

const clean = (s: string): string => sanitiseSourceText(s).replace(/\s+/g, " ").trim().slice(0, 300);

function asStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  return typeof v === "string" && v.trim() ? [v] : [];
}

/**
 * The company facts an agent may put in a prompt. An allow-list: contact
 * details, signatories, addresses, tax and registration numbers, the exposure
 * limit and every file name are never projected, and a fact appears only when
 * the agent holds its data category (AGENTS.md section 4). `keywords` and
 * `past_experience` are read when the profile has them.
 */
export function companyFacts(
  profile: CompanyProfile | null,
  documents: CompanyDocumentMeta[],
  granted: ReadonlySet<DataCategory>,
  now: Date,
): CompanyFact[] {
  const facts: CompanyFact[] = [];
  const add = (key: string, label: string, value: string, category: DataCategory) => {
    const v = clean(value);
    if (v && granted.has(category)) facts.push({ id: `fact:${key}`, label, value: v, category, provenance: "COMPANY_PROFILE" });
  };

  if (profile) {
    const extra = profile as unknown as Record<string, unknown>;
    if (profile.legal_name) add("legal_name", "Registered name", profile.legal_name, "COMPANY_PROFILE");
    if (profile.trading_name) add("trading_name", "Trading name", profile.trading_name, "COMPANY_PROFILE");
    if (profile.cidb_grade) add("cidb_grade", "CIDB grade", profile.cidb_grade, "COMPANY_PROFILE");
    if (profile.bbbee_level != null) add("bbbee_level", "B-BBEE level", `Level ${profile.bbbee_level}`, "COMPANY_PROFILE");
    if (profile.provinces.length) add("provinces", "Provinces of operation", profile.provinces.map((p) => (provinceLabel(p) !== "—" ? provinceLabel(p) : p)).join(", "), "COMPANY_PROFILE");
    if (profile.sectors.length) add("sectors", "Sectors", profile.sectors.join(", "), "COMPANY_CAPABILITIES");
    const keywords = asStrings(extra.keywords);
    if (keywords.length) add("keywords", "Capability keywords", keywords.join(", "), "COMPANY_CAPABILITIES");
    const experience = asStrings(extra.past_experience);
    if (experience.length) add("past_experience", "Past experience", experience.join("; "), "COMPANY_CAPABILITIES");
  }

  for (const d of documents) {
    const type = documentType(d.doc_type);
    const category = type?.category;
    if (!type || !category || !d.verified) continue;
    if ((PROMPT_PROHIBITED_CATEGORIES as readonly string[]).includes(category)) continue;
    if (!FACT_DOCUMENT_CATEGORIES.includes(category) || !granted.has(category)) continue;
    if (d.expires_at && endOfDaySast(d.expires_at) < now.getTime()) continue;
    const expiry = d.expires_at ? ` (valid until ${d.expires_at})` : "";
    facts.push({ id: `doc:${d.id}`, label: type.label, value: `${clean(d.title)}${expiry}`, category, provenance: "VERIFIED_DOCUMENT" });
  }
  return facts;
}

/** One citable line per fact, as shown to the model. */
export function renderFacts(facts: CompanyFact[]): string {
  return facts.map((f) => `[${f.id}] ${f.label}: ${f.value}`).join("\n");
}
