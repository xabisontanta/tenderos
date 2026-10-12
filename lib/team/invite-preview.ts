import "server-only";

import { getAdminSupabase } from "@/lib/supabase/admin";
import { INVITE_TOKEN } from "./invite-link";
import type { OrgRole } from "./roles";

export type InvitePreview =
  | { status: "ok"; invitationId: string; organisationId: string; organisationName: string; role: OrgRole; email: string; expiresAt: string }
  | { status: "invalid" }
  | { status: "error" };

/**
 * What the invite page and the onboarding page may show about the token in a visitor's cookie, before or without
 * the visitor being signed in: which organisation, which role, and which address it was sent to. That is only what
 * the email already said. An expired, revoked, used or unknown token is just "invalid" (the database says nothing
 * more), and a lookup that failed is "error", so the page never calls a live link dead because the database blinked.
 * Runs as the service role through `invitation_preview`, which no browser can call.
 */
export async function previewInvitation(token: string): Promise<InvitePreview> {
  if (!INVITE_TOKEN.test(token)) return { status: "invalid" };
  const { data, error } = await getAdminSupabase().rpc("invitation_preview", { p_token: token });
  if (error) return { status: "error" };
  const row = data?.[0];
  if (!row) return { status: "invalid" };
  return {
    status: "ok",
    invitationId: row.invitation_id,
    organisationId: row.organisation_id,
    organisationName: row.organisation_name,
    role: row.role,
    email: row.email,
    expiresAt: row.expires_at,
  };
}
