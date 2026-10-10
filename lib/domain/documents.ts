import type { Database } from "@/types/database";

type DataCategory = Database["public"]["Enums"]["data_category"];

export interface DocumentType {
  key: string;
  label: string;
  /** POPIA data category: only agents granted it can see the document. */
  category: DataCategory;
  /** Whether the document carries an expiry date that compliance must check. */
  expires: boolean;
  hint?: string;
}

/**
 * Company documents the agents use when preparing bids. Keys that match the
 * compliance checklist (agents/compliance/logic.ts) count as evidence for
 * that item. Mirrored by the doc_type check and private.document_category()
 * in the database; a parity test keeps them identical.
 */
export const DOCUMENT_TYPES: DocumentType[] = [
  { key: "cipc_registration", label: "CIPC registration certificate", category: "COMPANY_PROFILE", expires: false, hint: "CoR 14.3 or the CIPC disclosure" },
  { key: "csd_registration", label: "CSD registration report", category: "COMPANY_PROFILE", expires: false, hint: "Full summary report from csd.gov.za" },
  { key: "tax_compliance", label: "SARS tax compliance status", category: "TAX", expires: true, hint: "TCS PIN letter from SARS eFiling" },
  { key: "bbbee", label: "B-BBEE certificate or sworn affidavit", category: "BBBEE", expires: true },
  { key: "sbd_declarations", label: "Signed standard bidding documents", category: "COMPANY_PROFILE", expires: false, hint: "SBD 1, SBD 4, SBD 6.1" },
  { key: "cidb_grading", label: "CIDB grading certificate", category: "CERTIFICATIONS", expires: true },
  { key: "coida", label: "COIDA letter of good standing", category: "CERTIFICATIONS", expires: true },
  { key: "insurance", label: "Insurance certificate", category: "INSURANCE", expires: true, hint: "e.g. public liability" },
  { key: "company_profile_doc", label: "Company profile", category: "COMPANY_CAPABILITIES", expires: false },
  { key: "project_references", label: "Reference letters", category: "PROJECT_REFERENCES", expires: false },
  { key: "financial_statements", label: "Financial statements", category: "FINANCIAL", expires: false },
  { key: "bank_confirmation", label: "Bank confirmation letter", category: "BANKING", expires: false },
  { key: "director_ids", label: "Director ID copies", category: "DIRECTOR_PERSONAL", expires: false },
  { key: "proof_of_address", label: "Proof of address", category: "PROOF_OF_ADDRESS", expires: false },
  { key: "other", label: "Other document", category: "COMPANY_PROFILE", expires: false },
];

export const DOCUMENT_BUCKET = "company-documents";
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const ALLOWED_DOCUMENT_MIME = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export function documentType(key: string): DocumentType | undefined {
  return DOCUMENT_TYPES.find((t) => t.key === key);
}

/** Categories only owners and admins may open (mirrors private.can_read_document). */
export const RESTRICTED_DOCUMENT_CATEGORIES = ["DIRECTOR_PERSONAL", "BANKING", "PROOF_OF_ADDRESS"] as const;

export function canReadDocumentType(docType: string, isAdmin: boolean): boolean {
  const category = documentType(docType)?.category;
  return isAdmin || !(RESTRICTED_DOCUMENT_CATEGORIES as readonly string[]).includes(category ?? "");
}

const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  "application/pdf": (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "application/msword": (b) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
};

/** True when the file's first bytes match the type the browser declared for it. */
export function contentMatchesType(mimeType: string | null, head: Uint8Array): boolean {
  const check = mimeType ? SIGNATURES[mimeType] : undefined;
  return check ? head.length >= 4 && check(head) : false;
}
