import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { authRedirectUrl } from "@/lib/auth/urls";
import { safeRedirectPath } from "@/lib/safe-redirect";

// Types of emailed link this route finishes. Invitations get their own flow.
const linkSchema = z.object({
  token_hash: z.string().min(8).max(512),
  type: z.enum(["email", "signup", "recovery", "email_change"]),
});

/**
 * Completes an emailed confirmation or password-reset link that carries a
 * `token_hash` (see docs/auth.md for the email template links). Unlike the
 * PKCE `code` that /auth/callback exchanges, a token hash does not depend on
 * a verifier stored in the browser that asked for the email, so the link works
 * when it is opened on a phone or in another browser, which is the usual case.
 *
 * Redirects are built from APP_URL, and `next` only survives safeRedirectPath.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const link = linkSchema.safeParse({ token_hash: params.get("token_hash"), type: params.get("type") });
  if (link.success) {
    const supabase = await getServerSupabase();
    const { error } = await supabase.auth.verifyOtp({ type: link.data.type, token_hash: link.data.token_hash });
    if (!error) {
      const fallback = link.data.type === "recovery" ? "/reset-password" : "/";
      const next = params.get("next");
      return NextResponse.redirect(authRedirectUrl(next ? safeRedirectPath(next) : fallback));
    }
  }
  const failed = new URL(authRedirectUrl("/login"));
  failed.searchParams.set("error", "link_invalid");
  return NextResponse.redirect(failed);
}
