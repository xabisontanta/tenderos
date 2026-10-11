import { expiryNote, safety, template } from "./shared";

/** Supabase "Magic link": passwordless sign-in. The app does not offer it yet; kept branded so enabling it never sends a default email. */
export const magicLink = template("magic_link", "Your TenderOS sign-in link", ["Email", "ConfirmationURL", "Token", "TokenHash"], () => ({
  title: "Sign in to TenderOS",
  preheader: "Open this link to sign in as {{ .Email }}. It works once and expires in 1 hour.",
  eyebrow: { label: "Sign in", icon: "log-in" },
  headline: "Sign in to TenderOS",
  blocks: [
    { type: "p", text: ["Use the button below to sign in as ", { strong: "{{ .Email }}" }, ". No password is needed."] },
    { type: "button", label: "Sign in to TenderOS", href: "{{ .ConfirmationURL }}", note: expiryNote() },
    { type: "linkFallback", href: "{{ .ConfirmationURL }}" },
    safety(
      "Didn't ask to sign in?",
      "You can ignore this email: the link only works if someone opens it. If these keep arriving and you did not ask for them, write to us at the address below.",
    ),
  ],
  reason: "a sign-in link was requested for {{ .Email }}",
}));
