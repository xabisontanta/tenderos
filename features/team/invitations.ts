"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { requireContext } from "@/lib/data/context";
import { toUserError, type ActionResult } from "@/lib/actions";
import { sendTeamInvitation } from "@/lib/email/team-invitation";
import { inviteUrl } from "@/lib/team/invite-link";
import { invitableRoles, isOrgRole, type OrgRole } from "@/lib/team/roles";

/**
 * What the inviter gets back. `link` is the plaintext invitation link and exists only in this response: the
 * database keeps a hash. It is shown once, for the case where the email did not arrive or the inviter prefers to
 * pass it on themselves. The link alone accepts nothing: the invited address must be signed in.
 */
export interface IssuedInvitation {
  id: string;
  email: string;
  link: string;
  emailed: boolean;
  /** Why the email did not go, in words for the inviter; null when it did. */
  notice: string | null;
  expiresAt: string;
}

interface Issued {
  invitation_id: string;
  token: string;
  expires_at: string;
}

const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address").max(254, "Enter a valid email address");
const idSchema = z.string().uuid("Choose an invitation");

const NO_MAIL_HERE = "No email was sent: this server has no mail set up. Share the link below with the person yourself.";

async function emailInvitation(
  ctx: Awaited<ReturnType<typeof requireContext>>,
  to: string,
  role: OrgRole,
  issued: Issued,
): Promise<Pick<IssuedInvitation, "emailed" | "notice">> {
  const sent = await sendTeamInvitation({
    to,
    inviterName: ctx.fullName?.trim() || "A colleague",
    organisationName: ctx.organisation.name,
    role,
    token: issued.token,
    expiresAt: issued.expires_at,
  });
  if (!sent.ok) return { emailed: false, notice: `${sent.error}. The invitation exists: share the link below with the person yourself.` };
  if (!sent.delivered) return { emailed: false, notice: NO_MAIL_HERE };
  return { emailed: true, notice: null };
}

/**
 * Invites an address to the organisation with a role. The database decides who may and enforces the limits
 * (20 an hour, 50 pending, five a day to one address); this action never looks up whether the address has an
 * account, so its answer cannot tell. The invitation is created before the email is tried, and a failed email
 * does not undo it: the link comes back so it can be shared by hand, and "Resend" rotates it.
 */
export async function inviteMember(email: string, role: string): Promise<ActionResult<IssuedInvitation>> {
  const ctx = await requireContext();
  const parsed = emailSchema.safeParse(email ?? "");
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  if (!isOrgRole(role) || !invitableRoles(ctx.role).includes(role)) {
    return {
      ok: false,
      error: ctx.role === "admin" ? "Admins can invite operators and viewers. Ask an owner to invite an admin." : "Choose a role to invite them as",
    };
  }
  const supabase = await getServerSupabase();
  const { data, error } = await supabase.rpc("create_invitation", { p_org: ctx.organisation.id, p_email: parsed.data, p_role: role });
  const issued = (data as Issued[] | null)?.[0];
  if (error || !issued) return { ok: false, error: toUserError(error, "Could not create the invitation") };
  const mail = await emailInvitation(ctx, parsed.data, role, issued);
  revalidatePath("/settings");
  return { ok: true, data: { id: issued.invitation_id, email: parsed.data, link: inviteUrl(issued.token), expiresAt: issued.expires_at, ...mail } };
}

/** Sends a pending invitation again with a new link; the old link stops working. */
export async function resendInvitation(id: string): Promise<ActionResult<IssuedInvitation>> {
  const ctx = await requireContext();
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const supabase = await getServerSupabase();
  const { data, error } = await supabase.rpc("resend_invitation", { p_id: parsed.data });
  const issued = (data as Issued[] | null)?.[0];
  if (error || !issued) return { ok: false, error: toUserError(error, "Could not resend the invitation") };
  // Owners and admins can read their organisation's invitations (not the token hash).
  const { data: row } = await supabase.from("organisation_invitations").select("email, role").eq("id", parsed.data).maybeSingle();
  revalidatePath("/settings");
  const link = inviteUrl(issued.token);
  if (!row || !isOrgRole(row.role)) {
    return {
      ok: true,
      data: {
        id: issued.invitation_id,
        email: "",
        link,
        expiresAt: issued.expires_at,
        emailed: false,
        notice: "The invitation was renewed. Share the link below with the person yourself.",
      },
    };
  }
  const mail = await emailInvitation(ctx, row.email, row.role, issued);
  return { ok: true, data: { id: issued.invitation_id, email: row.email, link, expiresAt: issued.expires_at, ...mail } };
}

/** Withdraws a pending invitation; its link stops working at once. */
export async function revokeInvitation(id: string): Promise<ActionResult> {
  await requireContext();
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("revoke_invitation", { p_id: parsed.data });
  if (error) return { ok: false, error: toUserError(error, "Could not revoke the invitation") };
  revalidatePath("/settings");
  return { ok: true };
}
