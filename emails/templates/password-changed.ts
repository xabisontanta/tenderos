import { SITE, notification } from "./shared";

/** Security notification: password changed. Docs show no .Email in this template, so none is used. */
export const passwordChanged = notification("password_changed", "Your TenderOS password was changed", [], () => ({
  title: "Your TenderOS password was changed",
  preheader: "The password on your TenderOS account was changed. If that was not you, act now.",
  eyebrow: { label: "Account security", icon: "lock-keyhole" },
  headline: "Your password was changed",
  blocks: [
    { type: "p", text: "The password on your TenderOS account was changed. You are receiving this email so that you always know when that happens." },
    { type: "notice", tone: "success", title: "If this was you", body: "There is nothing more to do. Keep working as usual." },
    {
      type: "notice",
      tone: "danger",
      title: "If this wasn't you",
      body: "Someone else may have access to your account. Reset your password straight away, then write to us at the address below so we can look into it.",
    },
    { type: "button", label: "Reset my password", href: `${SITE}/forgot-password` },
  ],
  reason: "the password on your TenderOS account was changed",
}));
