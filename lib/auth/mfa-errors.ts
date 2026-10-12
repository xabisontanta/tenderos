/**
 * What to tell a person when Supabase Auth refuses an MFA call. The server's own messages ("Invalid TOTP code
 * entered") are for developers, so only the stable error `code` is read. The codes are the ones in
 * `@supabase/auth-js` (lib/error-codes.d.ts); an unknown code gets the caller's fallback.
 */
export const VERIFY_FIRST = "Verify with your authenticator, then try again.";

export interface AuthLikeError {
  code?: string;
  status?: number;
  message?: string;
}

const MESSAGES: Record<string, string> = {
  mfa_verification_failed: "That code did not work. Check the code in your authenticator app (and that your phone's clock is correct), then try again.",
  mfa_verification_rejected: "That code did not work. Check the code in your authenticator app (and that your phone's clock is correct), then try again.",
  validation_failed: "That code did not work. Enter the six digits from your authenticator app.",
  mfa_challenge_expired: "That code took too long. Enter the current code from your authenticator app.",
  mfa_factor_name_conflict: "You already have an authenticator with that name. Choose another name.",
  too_many_enrolled_mfa_factors: "You have reached the limit of authenticators. Remove one you no longer use, then add this one.",
  insufficient_aal: VERIFY_FIRST,
  mfa_factor_not_found: "That authenticator no longer exists. Reload the page.",
  mfa_totp_enroll_not_enabled: "Authenticator apps are not switched on for this TenderOS server. Ask whoever runs it to enable them.",
  mfa_totp_verify_not_enabled: "Authenticator apps are not switched on for this TenderOS server. Ask whoever runs it to enable them.",
  over_request_rate_limit: "Too many attempts. Wait a minute and try again.",
  mfa_ip_address_mismatch: "Your connection changed while you were verifying. Reload the page and try again.",
};

export function mfaErrorMessage(error: AuthLikeError | null | undefined, fallback: string): string {
  if (!error) return fallback;
  if (error.code && MESSAGES[error.code]) return MESSAGES[error.code];
  if (error.status === 429) return MESSAGES.over_request_rate_limit;
  return fallback;
}
