import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { canAdminister, requireContext } from "@/lib/data/context";
import { serverEnv } from "@/lib/env";
import { exchangeGoogleCode, googleConfig, OAUTH_COOKIE } from "@/lib/email/gmail";
import { getServerSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function GET(req: NextRequest) {
  const appUrl = serverEnv().APP_URL;
  const done = (result: string) => {
    const res = NextResponse.redirect(new URL(`/settings?email=${result}`, appUrl));
    res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/email/google" });
    return res;
  };
  const ctx = await requireContext();
  const cfg = googleConfig();
  let saved: { state?: string; verifier?: string; org?: string; user?: string } = {};
  try {
    saved = JSON.parse(req.cookies.get(OAUTH_COOKIE)?.value ?? "{}");
  } catch {
    saved = {};
  }
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const code = req.nextUrl.searchParams.get("code");
  if (!cfg || !code || !saved.state || !saved.verifier || !same(state, saved.state)) return done("failed");
  if (saved.org !== ctx.organisation.id || saved.user !== ctx.userId || !canAdminister(ctx.role)) return done("failed");
  try {
    const { refreshToken, email } = await exchangeGoogleCode(cfg, code, saved.verifier, `${appUrl}/api/email/google/callback`);
    const supabase = await getServerSupabase();
    const { error } = await supabase.rpc("connect_email_account", {
      p_org: ctx.organisation.id,
      p_provider: "GMAIL",
      p_from: email,
      p_display_name: ctx.fullName ?? "",
      p_secret: JSON.stringify({ refresh_token: refreshToken }),
    });
    return done(error ? "failed" : "connected");
  } catch {
    return done("failed");
  }
}
