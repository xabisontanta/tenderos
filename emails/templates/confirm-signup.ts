import { expiryNote, safety, template } from "./shared";

/**
 * The link goes to the app's /auth/confirm route with the token hash instead of
 * Supabase's PKCE link, so it works when the email is opened in a different
 * browser or on a phone (docs/auth.md).
 */
const CONFIRM_URL = "{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/onboarding";

/** Supabase "Confirm sign up": sent after sign-up when email confirmation is on. */
export const confirmSignup = template("confirmation", "Confirm your email to open TenderOS", ["Email", "SiteURL", "Token", "TokenHash"], () => ({
  title: "Confirm your email address",
  preheader: "One tap to verify {{ .Email }} and finish setting up your account. The link works for 1 hour.",
  eyebrow: { label: "Confirm your email", icon: "mail-check" },
  headline: "Confirm your email address",
  blocks: [
    { type: "p", text: ["Welcome to TenderOS. Confirm that ", { strong: "{{ .Email }}" }, " is yours and we will finish setting up your account."] },
    {
      type: "p",
      text: "Once you are in, add your company details so the Tender Scout can look for tenders that suit your business. You approve every bid before it goes anywhere.",
    },
    { type: "button", label: "Confirm email address", href: CONFIRM_URL, note: expiryNote() },
    { type: "linkFallback", href: CONFIRM_URL },
    safety(
      "Didn't create a TenderOS account?",
      "You can ignore this email. The account stays unconfirmed and cannot be used to sign in. Someone may have typed your address by mistake.",
    ),
  ],
  reason: "someone signed up for TenderOS with {{ .Email }}",
}));
