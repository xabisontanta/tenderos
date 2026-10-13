/**
 * Brand constants and the legal sender block shared by every TenderOS email.
 *
 * The legal block is a requirement of a transactional email footer (who sent
 * this, where they are registered). The values are not known to the codebase,
 * so they default to visible [placeholders] and are filled from the
 * environment when the templates are built or an app email is rendered:
 *
 *   EMAIL_LEGAL_NAME, EMAIL_LEGAL_ADDRESS, EMAIL_REGISTRATION_NUMBER,
 *   EMAIL_SUPPORT_ADDRESS
 *
 * `npm run build:emails` warns about every placeholder that is still in place,
 * and fails when EMAIL_STRICT=1 (use that in the release pipeline).
 */

export const BRAND_NAME = "TenderOS";
export const BRAND_TAGLINE = "Tender operations command centre";

export interface Brand {
  name: string;
  tagline: string;
  /** Registered company name, as on the CIPC certificate. */
  legalName: string;
  /** Registered or physical address, one line. */
  legalAddress: string;
  /** CIPC registration number. */
  registrationNumber: string;
  /** Address people can write to for help. Shown as text, never auto-linked. */
  supportEmail: string;
}

export const PLACEHOLDERS = {
  legalName: "[Registered company name]",
  legalAddress: "[Registered address]",
  registrationNumber: "[Registration number]",
  supportEmail: "[Support email address]",
} as const satisfies Record<string, string>;

type LegalKey = keyof typeof PLACEHOLDERS;

/** A single line, trimmed, with control characters removed. Empty means "unset". */
function clean(value: string | undefined): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

export function resolveBrand(env: Record<string, string | undefined> = process.env): Brand {
  const pick = (name: string, key: LegalKey) => clean(env[name]) || PLACEHOLDERS[key];
  return {
    name: BRAND_NAME,
    tagline: BRAND_TAGLINE,
    legalName: pick("EMAIL_LEGAL_NAME", "legalName"),
    legalAddress: pick("EMAIL_LEGAL_ADDRESS", "legalAddress"),
    registrationNumber: pick("EMAIL_REGISTRATION_NUMBER", "registrationNumber"),
    supportEmail: pick("EMAIL_SUPPORT_ADDRESS", "supportEmail"),
  };
}

/** The legal fields that still hold a [placeholder]. */
export function unresolvedPlaceholders(brand: Brand): LegalKey[] {
  return (Object.keys(PLACEHOLDERS) as LegalKey[]).filter((key) => brand[key] === PLACEHOLDERS[key]);
}
