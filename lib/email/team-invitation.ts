import "server-only";

import { renderTeamInvitation } from "@/emails/templates/team-invitation";
import { appUrl } from "@/lib/env";
import { createLogger } from "@/lib/log";
import type { OrgRole } from "@/lib/team/roles";
import { inviteUrl } from "@/lib/team/invite-link";
import { sendPlatformEmail, type PlatformMailDeps, type PlatformMailResult } from "./platform";

const log = createLogger({ module: "team-invitation-email" });

export interface TeamInvitationEmail {
  /** The invited address. */
  to: string;
  inviterName: string;
  organisationName: string;
  role: OrgRole;
  /** The plaintext token from create_invitation or resend_invitation. It goes in the link and nowhere else. */
  token: string;
  expiresAt: Date | string;
}

/**
 * Renders the branded `teamInvitation` email (emails/templates/team-invitation.ts) and sends it through the
 * platform mailer. The link is `${APP_URL}/invite/<token>`. A failure to render (an expired invitation, a
 * link that is not https in production) is a failed send, never a thrown error, so the caller can still hand
 * the inviter the link.
 */
export async function sendTeamInvitation(input: TeamInvitationEmail, deps: PlatformMailDeps = {}): Promise<PlatformMailResult> {
  const env = deps.env ?? process.env;
  let mail;
  try {
    mail = renderTeamInvitation(
      {
        inviterName: input.inviterName,
        organisationName: input.organisationName,
        role: input.role,
        recipientEmail: input.to,
        acceptUrl: inviteUrl(input.token, env),
        expiresAt: input.expiresAt,
      },
      { appUrl: appUrl(env), production: env.NODE_ENV === "production" },
    );
  } catch (err) {
    // Some renderer messages quote the link, and the link carries the token: only known, link-free reasons are logged.
    const message = (err as Error).message;
    const known = /^(APP_URL |The invitation has already expired|Unknown role|Not an invitation token)/.test(message);
    log.error("team invitation email could not be prepared", { problem: known ? message.slice(0, 120) : "see the renderer" });
    return { ok: false, error: "The invitation email could not be prepared" };
  }
  return sendPlatformEmail({ to: input.to, subject: mail.subject, html: mail.html, text: mail.text, kind: "team_invitation" }, deps);
}
