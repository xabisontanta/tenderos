import { randomBytes, createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { canAdminister, requireContext } from "@/lib/data/context";
import { serverEnv } from "@/lib/env";
import { googleAuthUrl, googleConfig, OAUTH_COOKIE } from "@/lib/email/gmail";

export const runtime = "nodejs";

/** Starts Google consent for send-only Gmail access (PKCE + state bound to an httpOnly cookie). */
export async function GET(req: NextRequest) {
  const ctx = await requireContext();
  const appUrl = serverEnv().APP_URL;
  const cfg = googleConfig();
  if (!cfg || !canAdminister(ctx.role)) return NextResponse.redirect(new URL("/settings?email=unavailable", appUrl));
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = `${appUrl}/api/email/google/callback`;
  const res = NextResponse.redirect(googleAuthUrl(cfg, redirectUri, state, challenge, ctx.email ?? undefined));
  res.cookies.set(OAUTH_COOKIE, JSON.stringify({ state, verifier, org: ctx.organisation.id, user: ctx.userId }), {
    httpOnly: true,
    secure: req.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/api/email/google",
    maxAge: 600,
  });
  return res;
}
