import { expiryNote, safety, template } from "./shared";

/**
 * Supabase "Change email address". With double_confirm_changes on, Supabase
 * sends this to both the current and the new address, so the copy covers both.
 */
export const emailChange = template(
  "email_change",
  "Confirm your new TenderOS email address",
  ["Email", "NewEmail", "ConfirmationURL", "Token", "TokenHash"],
  () => ({
    title: "Confirm your new email address",
    preheader: "Confirm {{ .NewEmail }} as the email address for your TenderOS account.",
    eyebrow: { label: "Email change", icon: "at-sign" },
    headline: "Confirm your new email address",
    blocks: [
      { type: "p", text: "You asked to change the email address on your TenderOS account." },
      {
        type: "details",
        rows: [
          { label: "Current address", value: "{{ .Email }}" },
          { label: "New address", value: { strong: "{{ .NewEmail }}" } },
        ],
      },
      {
        type: "p",
        text: "Confirm the change to start signing in with the new address. If you are asked to confirm from both addresses, the change only takes effect once both links have been used.",
      },
      { type: "button", label: "Confirm new email address", href: "{{ .ConfirmationURL }}", note: expiryNote() },
      { type: "linkFallback", href: "{{ .ConfirmationURL }}" },
      safety(
        "Didn't ask to change your email?",
        "Do not open the link: your sign-in address stays as it is. Reset your password to be safe, then write to us at the address below.",
      ),
    ],
    reason: "a change of email address was requested on the TenderOS account for {{ .Email }}",
  }),
);
