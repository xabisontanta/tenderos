const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * Builds the Content-Security-Policy for a request. Scripts are restricted to
 * a per-request nonce (plus 'strict-dynamic' so Next.js chunks load); the only
 * network destinations allowed are this origin and the Supabase project.
 *
 * With `turnstile` set (CAPTCHA configured) Cloudflare's challenge origin is
 * also allowed for scripts, frames and connections, and nothing else changes.
 */
export function buildCsp(nonce: string, supabaseUrl: string, isDev: boolean, opts: { turnstile?: boolean } = {}): string {
  const supabase = new URL(supabaseUrl);
  const wsProtocol = supabase.protocol === "https:" ? "wss:" : "ws:";
  const cf = opts.turnstile ? [TURNSTILE_ORIGIN] : [];
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...cf, ...(isDev ? ["'unsafe-eval'"] : [])],
    // Tailwind and React inline style attributes require 'unsafe-inline' for styles.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", supabase.origin, `${wsProtocol}//${supabase.host}`, ...cf],
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
  };
  if (opts.turnstile) directives["frame-src"] = [TURNSTILE_ORIGIN];
  if (!isDev) directives["upgrade-insecure-requests"] = [];
  return Object.entries(directives)
    .map(([k, v]) => (v.length ? `${k} ${v.join(" ")}` : k))
    .join("; ");
}

export const STATIC_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};
