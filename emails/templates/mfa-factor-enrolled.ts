import { FACTOR_LABEL, SITE, notification } from "./shared";

/** Security notification: a second sign-in step (authenticator app, phone, security key) was added. */
export const mfaFactorEnrolled = notification("mfa_factor_enrolled", "A verification method was added to your TenderOS account", ["FactorType"], () => ({
  title: "A verification method was added to your TenderOS account",
  preheader: "A new way to verify your sign-in was added to your TenderOS account.",
  eyebrow: { label: "Account security", icon: "shield-check" },
  headline: "A verification method was added",
  blocks: [
    { type: "p", text: "A new way to verify your sign-in was added to your TenderOS account. From now on you may be asked for it when you sign in." },
    { type: "details", rows: [{ label: "Method", value: { raw: FACTOR_LABEL } }] },
    { type: "notice", tone: "success", title: "If this was you", body: "There is nothing more to do. Your account is better protected." },
    {
      type: "notice",
      tone: "danger",
      title: "If this wasn't you",
      body: "Someone who can sign in as you has added it. Reset your password straight away, then write to us at the address below.",
    },
    { type: "button", label: "Reset my password", href: `${SITE}/forgot-password` },
  ],
  reason: "a verification method was added to your TenderOS account",
}));
