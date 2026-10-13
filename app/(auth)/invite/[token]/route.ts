import { NextResponse, type NextRequest } from "next/server";
import { appUrl } from "@/lib/env";
import { INVITE_COOKIE, inviteCookieOptions } from "@/lib/team/invite-cookie";
import { INVITE_TOKEN } from "@/lib/team/invite-link";

/**
 * The link in an invitation email. A page cannot set a cookie, so this handler does: it keeps the token in a
 * short-lived httpOnly cookie and redirects to /invite, which shows the invitation without the token in its
 * address. The response is not cached and sends no Referer, so the link does not travel any further, and the
 * redirect is built from APP_URL, never from the request. A value that is not shaped like a token sets nothing
 * and lands on the same page, which explains that the link did not work.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const origin = appUrl();
  const res = NextResponse.redirect(new URL("/invite", origin), 303);
  if (INVITE_TOKEN.test(token)) res.cookies.set(INVITE_COOKIE, token, inviteCookieOptions(origin));
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
