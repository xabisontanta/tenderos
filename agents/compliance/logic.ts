import type { TenderSnapshot } from "@/agents/runtime/types";
import type { ComplianceItem } from "./schema";

export interface VaultDocumentMeta {
  type: string;
  expiresAt: string | null;
  verified: boolean;
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
    return { ...item, status: "VALID", evidence: doc.expiresAt ? `Valid until ${doc.expiresAt}` : "Verified, no expiry" };
  });
}

export function isComplete(items: ComplianceItem[]): boolean {
  return items.every((i) => !i.mandatory || i.status === "VALID" || i.status === "EXPIRING_SOON");
}
