import { FACTOR_LABEL, SITE, notification } from "./shared";

/** Security notification: a second sign-in step was removed. */
export const mfaFactorUnenrolled = notification("mfa_factor_unenrolled", "A verification method was removed from your TenderOS account", ["FactorType"], () => ({
  title: "A verification method was removed from your TenderOS account",
  preheader: "A verification method was removed from your TenderOS account. Check that it was you.",
  eyebrow: { label: "Account security", icon: "shield-off" },
  headline: "A verification method was removed",
  blocks: [
    { type: "p", text: "A way of verifying your sign-in was removed from your TenderOS account. Your account is now less protected than before." },
    { type: "details", rows: [{ label: "Method removed", value: { raw: FACTOR_LABEL } }] },
    { type: "notice", tone: "success", title: "If this was you", body: "There is nothing more to do. Add another method whenever you are ready." },
    {
      type: "notice",
      tone: "danger",
      title: "If this wasn't you",
      body: "Someone who can sign in as you has removed it. Reset your password straight away, then write to us at the address below.",
    },
    { type: "button", label: "Reset my password", href: `${SITE}/forgot-password` },
  ],
  reason: "a verification method was removed from your TenderOS account",
}));
