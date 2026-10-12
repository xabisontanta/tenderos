import { expiryNote, safety, template } from "./shared";

/**
 * The link goes to the app's /auth/confirm route with the token hash instead of
 * Supabase's PKCE link, so it works when the email is opened in a different
 * browser or on a phone (docs/auth.md).
 */
const RESET_URL = "{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password";

/** Supabase "Reset password": sent by resetPasswordForEmail (features/auth/actions.ts requestPasswordReset). */
export const recovery = template("recovery", "Reset your TenderOS password", ["Email", "SiteURL", "Token", "TokenHash"], () => ({
  title: "Reset your TenderOS password",
  preheader: "Choose a new password for {{ .Email }}. The link works once and expires in 1 hour.",
  eyebrow: { label: "Password reset", icon: "key-round" },
  headline: "Reset your password",
  blocks: [
    { type: "p", text: ["We received a request to reset the password for ", { strong: "{{ .Email }}" }, "."] },
    { type: "p", text: "Choose a new one with the button below. Pick a strong password that you do not use anywhere else." },
    { type: "button", label: "Choose a new password", href: RESET_URL, note: expiryNote() },
    { type: "linkFallback", href: RESET_URL },
    safety(
      "Didn't ask for a password reset?",
      "You can ignore this email: your password has not changed. If these keep arriving, write to us at the address below.",
    ),
  ],
  reason: "a password reset was requested for {{ .Email }}",
}));
