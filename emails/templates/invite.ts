import { safety, template } from "./shared";

/**
 * Supabase "Invite user": sent by auth.admin.inviteUserByEmail. The inviter and
 * organisation are not template variables, so this one is deliberately
 * generic; app-sent team invitations (templates/team-invitation.ts) carry both.
 * The expiry is not stated because Supabase documents no invite-specific lifetime.
 */
export const invite = template("invite", "You have been invited to TenderOS", ["Email", "ConfirmationURL", "Token", "TokenHash"], () => ({
  title: "You have been invited to TenderOS",
  preheader: "Accept your invitation to set up your TenderOS account.",
  eyebrow: { label: "You're invited", icon: "user-plus" },
  headline: "You have been invited to TenderOS",
  blocks: [
    {
      type: "p",
      text: [
        "TenderOS is where South African businesses find tenders, prepare bids and approve every submission. You have been invited to join it with ",
        { strong: "{{ .Email }}" },
        ".",
      ],
    },
    { type: "p", text: "Accept the invitation to set up your account and sign in." },
    { type: "button", label: "Accept invitation", href: "{{ .ConfirmationURL }}", note: "The link works once. If it has expired, ask the person who invited you for a new invitation." },
    { type: "linkFallback", href: "{{ .ConfirmationURL }}" },
    safety("Weren't expecting this?", "Ignore this email and no account is set up. If you know who sent it and think it was a mistake, let them know."),
  ],
  reason: "an administrator invited {{ .Email }} to TenderOS",
}));
