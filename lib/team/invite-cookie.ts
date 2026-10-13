import "server-only";

import { cookies } from "next/headers";
import { appUrl } from "@/lib/env";
import { INVITE_TOKEN } from "./invite-link";

/**
 * The invitation token travels from the email link to the page that accepts it in this cookie, so it is
 * never in a URL the visitor keeps, bookmarks or sends on (and never in a log line). It is httpOnly (no
 * script reads it), SameSite=Lax (a link from another site still works; a form post from one does not carry it),
 * and lives two hours: long enough to sign up and confirm an address, short enough that a shared computer
 * does not keep it. The token alone accepts nothing: the invited address must be signed in.
 */
export const INVITE_COOKIE = "tos_invite";
export const INVITE_COOKIE_MAX_AGE = 2 * 60 * 60;

export function inviteCookieOptions(origin: string = appUrl()) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: new URL(origin).protocol === "https:",
    path: "/",
    maxAge: INVITE_COOKIE_MAX_AGE,
  };
}

/** The token in the visitor's cookie, or null when there is none or it is not shaped like one. */
export async function readInviteCookie(): Promise<string | null> {
  const value = (await cookies()).get(INVITE_COOKIE)?.value;
  return value && INVITE_TOKEN.test(value) ? value : null;
}

export async function clearInviteCookie(): Promise<void> {
  (await cookies()).delete(INVITE_COOKIE);
}
