import { expiryNote, safety, template } from "./shared";

/** Supabase "Confirm sign up": sent after sign-up when email confirmation is on. */
export const confirmSignup = template("confirmation", "Confirm your email to open TenderOS", ["Email", "ConfirmationURL", "Token", "TokenHash"], () => ({
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
    { type: "button", label: "Confirm email address", href: "{{ .ConfirmationURL }}", note: expiryNote() },
    { type: "linkFallback", href: "{{ .ConfirmationURL }}" },
    safety("Didn't create a TenderOS account?", "You can ignore this email. The account stays unconfirmed and cannot be used to sign in. Someone may have typed your address by mistake."),
  ],
  reason: "someone signed up for TenderOS with {{ .Email }}",
}));
