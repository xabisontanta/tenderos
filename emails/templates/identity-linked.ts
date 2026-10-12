import { PROVIDER_LABEL, SITE, notification } from "./shared";

/** Security notification: an outside sign-in (Google, Microsoft, ...) was linked to the account. */
export const identityLinked = notification("identity_linked", "A sign-in method was linked to your TenderOS account", ["Provider", "Email"], () => ({
  title: "A sign-in method was linked to your TenderOS account",
  preheader: "Another way to sign in was linked to your TenderOS account.",
  eyebrow: { label: "Account security", icon: "link" },
  headline: "A sign-in method was linked",
  blocks: [
    { type: "p", text: ["Another way to sign in was linked to your TenderOS account for ", { strong: "{{ .Email }}" }, "."] },
    { type: "details", rows: [{ label: "Sign-in method", value: { raw: PROVIDER_LABEL } }] },
    { type: "notice", tone: "success", title: "If this was you", body: "There is nothing more to do. You can now sign in with it." },
    {
      type: "notice",
      tone: "danger",
      title: "If this wasn't you",
      body: "Someone who can sign in as you has linked it. Reset your password straight away, then write to us at the address below.",
    },
    { type: "button", label: "Reset my password", href: `${SITE}/forgot-password` },
  ],
  reason: "a sign-in method was linked to your TenderOS account",
}));
