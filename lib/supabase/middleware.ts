import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { MFA_PATH, mfaRedirectPath, needsSecondFactor, type AalState } from "@/lib/auth/mfa";
import type { Database } from "@/types/database";

// /api/autofill authenticates the browser helper with its own pairing code.
// /terms and /privacy are linked from the sign-up form, so they must open signed out.
// /invite is where an invitation email lands: the visitor has no account or session yet.
const PUBLIC_PATHS = ["/login", "/signup", "/forgot-password", "/auth", "/api/autofill", "/terms", "/privacy", "/invite"];

/**
 * Refreshes the Supabase session cookie on every request and redirects
 * unauthenticated users to /login.
 */
export async function updateSession(request: NextRequest, requestHeaders: Headers) {
  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request: { headers: requestHeaders } });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  // getUser() validates the JWT with Supabase Auth; do not trust getSession() here.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = path === "/" ? "" : `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(url);
  }
  if (user && (path === "/login" || path === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }
  // A session that has proved only a password, for someone who has set up an authenticator, must pass the
  // challenge before it reaches anything else. (Whether the organisation *requires* an authenticator is the
  // database's decision, migration 063; this is for people who have chosen one.)
  if (user && !isPublic && path !== MFA_PATH && (await mustChallenge(supabase))) {
    const url = request.nextUrl.clone();
    url.pathname = MFA_PATH;
    url.search = mfaRedirectPath(`${path}${request.nextUrl.search}`).slice(MFA_PATH.length);
    return NextResponse.redirect(url);
  }
  return response;
}

/** Asks Supabase Auth for the session's assurance level. A failed lookup is not a lock-out: the page loads. */
async function mustChallenge(supabase: { auth: { mfa: { getAuthenticatorAssuranceLevel: () => Promise<{ data: AalState | null }> } } }): Promise<boolean> {
  try {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return needsSecondFactor(data);
  } catch {
    return false;
  }
}
