import { createHash } from "node:crypto";
import { submissionOutputSchema } from "@/agents/submission/schema";
import { ALLOWED_DOCUMENT_MIME } from "@/lib/domain/documents";

/**
 * Shapes and pure helpers for the browser helper API (/api/autofill). The
 * helper is a person's tool: it fills a tender portal form in their browser
 * and they submit it themselves. See extension/README.md.
 */

/** Pairing codes look like `tos_` followed by 64 hex characters (32 random bytes). */
export const AUTOFILL_TOKEN_PATTERN = /^tos_[a-f0-9]{64}$/;

/** Company profile fields that tender portal forms ask for. */
export const AUTOFILL_PROFILE_FIELDS = [
  "legal_name",
  "trading_name",
  "registration_number",
  "csd_number",
  "vat_number",
  "tax_pin",
  "tax_pin_expires_at",
  "bbbee_level",
  "bbbee_expires_at",
  "cidb_grade",
  "authorised_signatory",
  "contact_person",
  "contact_email",
  "contact_phone",
  "physical_address",
  "postal_address",
  "website",
] as const;

export type AutofillProfileField = (typeof AUTOFILL_PROFILE_FIELDS)[number];

/** Every field is present; a value the organisation has not entered is null, never a guess. */
export type AutofillProfile = Record<AutofillProfileField, string | number | null>;

export interface AutofillDocument {
  id: string;
  doc_type: string;
  title: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  expires_at: string | null;
}

export interface AutofillBidAttachment {
  key: string;
  label: string;
  document_id: string;
  /** Whether the document is among those this member's helper may attach now. */
  available: boolean;
}

export interface AutofillBid {
  submission_id: string;
  tender: {
    id: string;
    title: string;
    reference_number: string | null;
    issuing_organisation: string;
    closing_at: string;
    submission_method: string;
    submission_destination: string | null;
    source_url: string | null;
  };
  attachments: AutofillBidAttachment[];
}

export interface AutofillPayload {
  organisation: { name: string };
  member: { role: string };
  profile: AutofillProfile;
  documents: AutofillDocument[];
  bids: AutofillBid[];
  generated_at: string;
}

/** The pairing code from an `Authorization: Bearer` header, or null when missing or malformed. */
export function bearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer[ ]+(\S+)$/i.exec((header ?? "").trim());
  return match && AUTOFILL_TOKEN_PATTERN.test(match[1]) ? match[1] : null;
}

/** SHA-256 hex, the same value the database stores (`encode(digest(token, 'sha256'), 'hex')`). */
export function hashAutofillToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Every profile field, null where the organisation has not entered it. */
export function toAutofillProfile(row: Partial<Record<AutofillProfileField, unknown>> | null | undefined): AutofillProfile {
  return Object.fromEntries(
    AUTOFILL_PROFILE_FIELDS.map((k) => {
      const v = row?.[k];
      if (typeof v === "number") return [k, v];
      if (typeof v === "string" && v.trim() !== "") return [k, v.trim()];
      return [k, null];
    }),
  ) as AutofillProfile;
}

/** The documents the Submission Officer listed in an approved bid pack (`tasks.output.attachments`). */
export function bidPackAttachments(output: unknown): Array<{ key: string; label: string; document_id: string }> {
  const raw = output && typeof output === "object" ? (output as Record<string, unknown>).attachments : undefined;
  const parsed = submissionOutputSchema.shape.attachments.safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
}

/** A Content-Type that is one of the vault's allowed types, else a generic binary type. */
export function safeDocumentMime(mime: string | null | undefined): string {
  return mime && ALLOWED_DOCUMENT_MIME.includes(mime) ? mime : "application/octet-stream";
}

/** `attachment` disposition with an ASCII fallback and an RFC 5987 UTF-8 name. */
export function attachmentDisposition(fileName: string): string {
  const ascii =
    fileName
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\;]/g, "_")
      .trim() || "document";
  const utf8 = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
