import type { CompanyProfile, TenderSnapshot } from "@/agents/runtime/types";
import type { ComplianceItem } from "./schema";

export interface VaultDocumentMeta {
  type: string;
  expiresAt: string | null;
  verified: boolean;
  /** Where the fact came from, shown as evidence when valid. */
  source?: string;
}

/** Standard South African public-procurement returnables. */
export const BASE_CHECKLIST: Array<Pick<ComplianceItem, "key" | "label" | "category" | "mandatory">> = [
  { key: "cipc_registration", label: "CIPC company registration", category: "COMPANY_PROFILE", mandatory: true },
  { key: "csd_registration", label: "Central Supplier Database (CSD) summary report", category: "COMPANY_PROFILE", mandatory: true },
  { key: "tax_compliance", label: "SARS tax compliance status (TCS PIN)", category: "TAX", mandatory: true },
  { key: "bbbee", label: "B-BBEE certificate or sworn affidavit", category: "BBBEE", mandatory: false },
  { key: "sbd_declarations", label: "Standard bidding declarations (SBD 1, SBD 4, SBD 6.1)", category: "COMPANY_PROFILE", mandatory: true },
];

const EXPIRY_WARNING_DAYS = 30;

/**
 * Compares the checklist with document metadata from the vault. A document is
 * VALID only if it exists, is verified, and is in date at closing. Anything
 * else is reported; nothing is assumed.
 */
export function evaluateCompliance(tender: Pick<TenderSnapshot, "closing_at" | "sector">, vault: VaultDocumentMeta[] | null, now: Date): ComplianceItem[] {
  const checklist = [...BASE_CHECKLIST];
  if (tender.sector && /construct|civil|building|infrastructure/i.test(tender.sector)) {
    checklist.push({ key: "cidb_grading", label: "CIDB grading certificate", category: "CERTIFICATIONS", mandatory: true });
  }

  return checklist.map((item) => {
    if (vault === null) {
      return { ...item, status: "MISSING_INFORMATION", evidence: "Document vault not configured" };
    }
    const doc = vault.find((d) => d.type === item.key);
    if (!doc) return { ...item, status: "MISSING_INFORMATION", evidence: "No document on file" };
    if (!doc.verified) return { ...item, status: "REQUIRES_CONFIRMATION", evidence: "Document on file but not verified" };
    if (doc.expiresAt) {
      const exp = new Date(doc.expiresAt).getTime();
      if (exp < new Date(tender.closing_at).getTime()) {
        return { ...item, status: "EXPIRED", evidence: `Expires ${doc.expiresAt}, before closing` };
      }
      if (exp - now.getTime() < EXPIRY_WARNING_DAYS * 86_400_000) {
        return { ...item, status: "EXPIRING_SOON", evidence: `Expires ${doc.expiresAt}` };
      }
    }
    const from = doc.source ? `${doc.source}; ` : "";
    return { ...item, status: "VALID", evidence: `${from}${doc.expiresAt ? `valid until ${doc.expiresAt}` : "no expiry recorded"}` };
  });
}

export function isComplete(items: ComplianceItem[]): boolean {
  return items.every((i) => !i.mandatory || i.status === "VALID" || i.status === "EXPIRING_SOON");
}

/**
 * Company profile facts as checklist evidence. These are values the
 * organisation entered; they are reported as such, never as documents the
 * system has inspected.
 */
export function profileEvidence(p: CompanyProfile | null): VaultDocumentMeta[] | null {
  if (!p) return null;
  const docs: VaultDocumentMeta[] = [];
  const add = (type: string, present: unknown, source: string, expiresAt: string | null = null) => {
    if (present) docs.push({ type, verified: true, expiresAt, source });
  };
  add("cipc_registration", p.registration_number, `Registration ${p.registration_number} in company profile`);
  add("csd_registration", p.csd_number, `CSD ${p.csd_number} in company profile`);
  add("tax_compliance", p.tax_pin, "Tax compliance PIN in company profile", p.tax_pin_expires_at);
  add("bbbee", p.bbbee_level, `B-BBEE level ${p.bbbee_level} in company profile`, p.bbbee_expires_at);
  add("sbd_declarations", p.authorised_signatory, `To be signed by ${p.authorised_signatory} at approval`);
  add("cidb_grading", p.cidb_grade, `CIDB grade ${p.cidb_grade} in company profile`);
  return docs;
}
