import { PROVIDER_LABEL, SITE, notification } from "./shared";

/** Security notification: an outside sign-in was removed from the account. */
export const identityUnlinked = notification("identity_unlinked", "A sign-in method was removed from your TenderOS account", ["Provider", "Email"], () => ({
  title: "A sign-in method was removed from your TenderOS account",
  preheader: "A way to sign in was removed from your TenderOS account.",
  eyebrow: { label: "Account security", icon: "unlink" },
  headline: "A sign-in method was removed",
  blocks: [
    { type: "p", text: ["A way to sign in was removed from your TenderOS account for ", { strong: "{{ .Email }}" }, "."] },
    { type: "details", rows: [{ label: "Sign-in method removed", value: { raw: PROVIDER_LABEL } }] },
    { type: "notice", tone: "success", title: "If this was you", body: "There is nothing more to do. You can still sign in with your other methods." },
    {
      type: "notice",
      tone: "danger",
      title: "If this wasn't you",
      body: "Someone who can sign in as you has removed it. Reset your password straight away, then write to us at the address below.",
    },
    { type: "button", label: "Reset my password", href: `${SITE}/forgot-password` },
  ],
  reason: "a sign-in method was removed from your TenderOS account",
}));
