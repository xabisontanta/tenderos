"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServerSupabase } from "@/lib/supabase/server";
import { rateLimit, toUserError } from "@/lib/actions";
import { clearInviteCookie, readInviteCookie } from "@/lib/team/invite-cookie";
import type { FormState } from "@/features/auth/form-state";

/**
 * Accepts the invitation whose token is in the visitor's cookie, for the signed-in person. The token comes only
 * from the cookie, never from the form. Every attempt is counted first, because a call the database refuses rolls
 * back its own counter. The database does the real checks: the invitation is live, the signed-in address is
 * confirmed and is the invited one, and the person belongs to no other organisation. Its messages are written
 * for people and are shown as they are.
 */
export async function acceptInvitation(_: FormState, _formData: FormData): Promise<FormState> {
  const token = await readInviteCookie();
  if (!token) return { error: "We no longer have your invitation. Open the link in your invitation email again." };

  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=%2Finvite");

  const limited = await rateLimit(supabase, "invitation.accept_attempt", 20, 3600);
  if (limited) return { error: limited };

  const { error } = await supabase.rpc("accept_invitation", { p_token: token });
  if (error) {
    const message = toUserError(error, "Could not accept the invitation");
    // A dead invitation will not get better; the cookie only keeps offering it.
    if (/no longer valid|has expired/.test(message)) await clearInviteCookie();
    return { error: message };
  }
  await clearInviteCookie();
  revalidatePath("/", "layout");
  redirect("/");
}
