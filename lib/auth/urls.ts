import "server-only";

import { appUrl } from "@/lib/env";
import { safeRedirectPath } from "@/lib/safe-redirect";

/**
 * Absolute URL on this deployment for a link we hand to Supabase Auth (the
 * `emailRedirectTo` of a sign-up, the `redirectTo` of a password reset) or
 * redirect a browser to. The origin is APP_URL, never the request, so a forged
 * Origin or Host header cannot point an emailed link at another site.
 *
 * `next` is the page to open after the callback; it goes through
 * safeRedirectPath, so only same-site paths survive and anything else is
 * dropped (the callback then opens "/").
 */
export function authRedirectUrl(path: string, opts: { next?: string | null } = {}, env: Record<string, string | undefined> = process.env): string {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("authRedirectUrl needs a same-site path that starts with a single slash");
  }
  const url = new URL(path, appUrl(env));
  if (opts.next != null) {
    const next = safeRedirectPath(opts.next);
    if (next !== "/" || opts.next === "/") url.searchParams.set("next", next);
  }
  return url.toString();
}
