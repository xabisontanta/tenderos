import { expiryNote, safety, template } from "./shared";

/**
 * Supabase "Reauthentication": a six-digit code for sensitive changes
 * (secure_password_change). The code stays out of the subject and preheader so
 * it is not shown on lock screens or inbox previews.
 */
export const reauthentication = template("reauthentication", "Your TenderOS verification code", ["Token"], () => ({
  title: "Your TenderOS verification code",
  preheader: "Use the code inside to confirm it's you. It works once and expires in 1 hour.",
  eyebrow: { label: "Verification", icon: "shield-check" },
  headline: "Confirm it's you",
  blocks: [
    { type: "p", text: "TenderOS needs to check it is really you before a sensitive change, such as updating your password. Enter this code in the TenderOS window you have open:" },
    { type: "code", code: "{{ .Token }}", caption: expiryNote("code") },
    { type: "notice", tone: "warning", title: "Keep this code to yourself", body: "TenderOS will never ask you for it by phone, email or chat. Anyone who has it can change your account." },
    safety("Didn't ask for a code?", "A code is only sent while someone is signed in to your account. If that was not you, change your password straight away and write to us at the address below."),
  ],
  reason: "a verification code was requested on your TenderOS account",
}));
