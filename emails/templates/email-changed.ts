import { SITE, notification } from "./shared";

/** Security notification: the sign-in email address changed. */
export const emailChanged = notification("email_changed", "Your TenderOS email address was changed", ["Email", "OldEmail"], () => ({
  title: "Your TenderOS email address was changed",
  preheader: "The email address on your TenderOS account changed from {{ .OldEmail }} to {{ .Email }}.",
  eyebrow: { label: "Account security", icon: "at-sign" },
  headline: "Your email address was changed",
  blocks: [
    { type: "p", text: "The email address on your TenderOS account was changed. From now on, sign-in emails and account notices go to the new address." },
    {
      type: "details",
      rows: [
        { label: "Previous address", value: "{{ .OldEmail }}" },
        { label: "New address", value: { strong: "{{ .Email }}" } },
      ],
    },
    { type: "notice", tone: "success", title: "If this was you", body: "There is nothing more to do." },
    {
      type: "notice",
      tone: "danger",
      title: "If this wasn't you",
      body: "Someone may have taken over your account. Reset your password straight away and write to us at the address below.",
    },
    { type: "button", label: "Reset my password", href: `${SITE}/forgot-password` },
  ],
  reason: "the email address on your TenderOS account was changed",
}));
