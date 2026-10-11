import { contextFor, nowFor, renderApp, type AppEmail, type AppEmailOptions } from "../app";
import { formatClosing, formatRemaining, toDate } from "../format";
import type { EmailContent } from "../layout";

export type OrgRole = "owner" | "admin" | "operator" | "viewer";

/** What each role can do, from the policies in AGENTS.md section 8 and the RLS role checks. */
export const ROLE_INFO: Record<OrgRole, { label: string; summary: string }> = {
  owner: { label: "Owner", summary: "Everything an admin can do, with ownership of the organisation." },
  admin: { label: "Admin", summary: "Manages organisation settings, approves and sends bids, and can open restricted documents such as director IDs." },
  operator: { label: "Operator", summary: "Adds tenders, uploads documents and runs bid preparation. Operators cannot approve or send a bid." },
  viewer: { label: "Viewer", summary: "Read-only access to tenders, bids and activity." },
};

export interface TeamInvitationInput {
  inviterName: string;
  organisationName: string;
  role: OrgRole;
  /** The address the invitation was sent to. */
  recipientEmail: string;
  /** Link that accepts the invitation; must be https. */
  acceptUrl: string;
  expiresAt: Date | string;
}

/** Picks the most informative subject that fits one inbox line. */
function invitationSubject(inviter: string, organisation: string): string {
  const full = `${inviter} invited you to join ${organisation} on TenderOS`;
  if (full.length <= 78) return full;
  const withoutBrand = `${inviter} invited you to join ${organisation}`;
  if (withoutBrand.length <= 78) return withoutBrand;
  const prefix = "Invitation to join ";
  const suffix = " on TenderOS";
  const room = 78 - prefix.length - suffix.length;
  const org = organisation.length > room ? `${organisation.slice(0, room - 1).trimEnd()}…` : organisation;
  return `${prefix}${org}${suffix}`;
}

/** A person invited a colleague to an organisation. Sent by the app, not Supabase Auth. */
export function renderTeamInvitation(input: TeamInvitationInput, options: AppEmailOptions): AppEmail {
  const ctx = contextFor(options);
  const now = nowFor(options);
  const expires = toDate(input.expiresAt);
  if (expires.getTime() <= now.getTime()) throw new Error("The invitation has already expired");
  const role = ROLE_INFO[input.role];
  if (!role) throw new Error(`Unknown role: ${String(input.role)}`);
  const remaining = formatRemaining(expires.getTime() - now.getTime());
  const { inviterName: inviter, organisationName: org } = input;

  const content: EmailContent = {
    title: `${inviter} invited you to join ${org} on TenderOS`,
    preheader: `${inviter} invited you to ${org} as ${role.label}. The invitation expires ${remaining}.`,
    eyebrow: { label: "Team invitation", icon: "user-plus" },
    headline: `Join ${org} on TenderOS`,
    blocks: [
      { type: "p", text: [{ strong: inviter }, " has invited you to join ", { strong: org }, " on TenderOS as ", { strong: role.label }, "."] },
      {
        type: "p",
        text: "TenderOS is where South African businesses find tenders, prepare bids and keep a person approving every submission. Accept to work on your team's tenders.",
      },
      {
        type: "details",
        rows: [
          { label: "Organisation", value: org },
          { label: "Your role", value: [{ strong: role.label }, `. ${role.summary}`] },
          { label: "Invited by", value: inviter },
          { label: "Invitation for", value: input.recipientEmail },
          { label: "Expires", value: `${formatClosing(expires)}, ${remaining}` },
        ],
      },
      {
        type: "button",
        label: "Accept invitation",
        href: input.acceptUrl,
        note: `Sign in or create your account with ${input.recipientEmail}. The invitation is tied to that address.`,
      },
      { type: "linkFallback", href: input.acceptUrl },
      {
        type: "safety",
        title: `Don't know ${inviter}?`,
        body: `Ignore this email: nothing happens unless you accept. If you think it was sent to you in error, write to us at ${ctx.brand.supportEmail}.`,
      },
    ],
    reason: `${inviter} invited ${input.recipientEmail} to ${org} on TenderOS`,
  };
  return renderApp(content, invitationSubject(inviter, org), ctx);
}
