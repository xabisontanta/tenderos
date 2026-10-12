import { NextResponse, type NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase/server";
import { authRedirectUrl } from "@/lib/auth/urls";
import { safeRedirectPath } from "@/lib/safe-redirect";

/**
 * Completes email confirmation and password-reset links by exchanging the code for a session.
 * Redirects are built from APP_URL: behind a proxy the request URL can carry an
 * internal origin, and the browser must land on the public one to keep its cookies.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const target = safeRedirectPath(url.searchParams.get("next"));
  if (code) {
    const supabase = await getServerSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(authRedirectUrl(target));
  }
  const failed = new URL(authRedirectUrl("/login"));
  failed.searchParams.set("error", "link_invalid");
  return NextResponse.redirect(failed);
}
