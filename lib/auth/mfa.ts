import { safeRedirectPath } from "@/lib/safe-redirect";

/**
 * Multi-factor authentication helpers shared by the middleware, the sign-in action and the pages. Pure, so they
 * run in the edge middleware too. The facts about Supabase Auth's MFA API they rely on are in docs/auth.md.
 */
export const MFA_PATH = "/mfa";

/** What `supabase.auth.mfa.getAuthenticatorAssuranceLevel()` returns that this app looks at. */
export interface AalState {
  currentLevel: string | null;
  nextLevel: string | null;
}

/**
 * True when the session proved only a password (aal1) and the user has a verified factor, so the next level they
 * can reach is aal2. That session must pass the authenticator challenge before it is used for anything.
 */
export function needsSecondFactor(aal: AalState | null | undefined): boolean {
  return aal?.currentLevel === "aal1" && aal?.nextLevel === "aal2";
}

/**
 * `/mfa`, or `/mfa?next=<where they were going>`. The destination goes through safeRedirectPath, so only a path on this
 * site survives, and the dashboard and the challenge page itself are not remembered.
 */
export function mfaRedirectPath(next: unknown): string {
  const path = safeRedirectPath(next);
  if (path === "/" || path === MFA_PATH || path.startsWith(`${MFA_PATH}?`) || path.startsWith(`${MFA_PATH}/`)) return MFA_PATH;
  return `${MFA_PATH}?next=${encodeURIComponent(path)}`;
}

/** A TOTP code as typed: six ASCII digits, spaces and dashes (how apps group them) allowed. Null when it is not one. */
export function cleanTotpCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.replace(/[\s-]/g, "");
  return /^[0-9]{6}$/.test(code) ? code : null;
}

/** The QR code in an enrol response is an SVG data URL; anything else is not drawn. */
export function isQrDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/svg+xml;");
}
