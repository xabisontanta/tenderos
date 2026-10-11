/**
 * The versions of the terms of service and privacy notice now in force.
 *
 * These must match the row marked `is_current` for each kind in
 * public.legal_documents (see migration *_legal_consent.sql; the legal
 * integration test compares them). To publish a new version: add a migration
 * that inserts the row and flips is_current, then change the value here. Every
 * user who has not accepted the new version is asked to on their next visit.
 *
 * The first versions are drafts written for staging, pending review by a South
 * African attorney (docs/legal/popia-overview.md).
 */
export const LEGAL_KINDS = ["terms", "privacy"] as const;

export type LegalKind = (typeof LEGAL_KINDS)[number];

export const LEGAL_VERSIONS: Record<LegalKind, string> = {
  terms: "2026-10-11-draft",
  privacy: "2026-10-11-draft",
};

export const LEGAL_TITLES: Record<LegalKind, string> = {
  terms: "Terms of Service",
  privacy: "Privacy Notice",
};

export const LEGAL_PATHS: Record<LegalKind, string> = {
  terms: "/terms",
  privacy: "/privacy",
};
