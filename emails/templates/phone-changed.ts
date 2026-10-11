import { SITE, notification } from "./shared";

/** Security notification: the phone number changed. TenderOS has no phone sign-in today; kept so enabling it never sends a default email. */
export const phoneChanged = notification("phone_changed", "Your TenderOS phone number was changed", ["Phone", "OldPhone"], () => ({
  title: "Your TenderOS phone number was changed",
  preheader: "The phone number on your TenderOS account was changed.",
  eyebrow: { label: "Account security", icon: "smartphone" },
  headline: "Your phone number was changed",
  blocks: [
    { type: "p", text: "The phone number on your TenderOS account was changed." },
    {
      type: "details",
      rows: [
        { label: "Previous number", value: "{{ .OldPhone }}" },
        { label: "New number", value: { strong: "{{ .Phone }}" } },
      ],
    },
    { type: "notice", tone: "success", title: "If this was you", body: "There is nothing more to do." },
    {
      type: "notice",
      tone: "danger",
      title: "If this wasn't you",
      body: "Someone may have access to your account. Reset your password straight away and write to us at the address below.",
    },
    { type: "button", label: "Reset my password", href: `${SITE}/forgot-password` },
  ],
  reason: "the phone number on your TenderOS account was changed",
}));
