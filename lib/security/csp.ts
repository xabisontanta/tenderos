/**
 * Builds the Content-Security-Policy for a request. Scripts are restricted to
 * a per-request nonce (plus 'strict-dynamic' so Next.js chunks load); the only
 * network destinations allowed are this origin and the Supabase project.
 */
export function buildCsp(nonce: string, supabaseUrl: string, isDev: boolean): string {
  const supabase = new URL(supabaseUrl);
  const wsProtocol = supabase.protocol === "https:" ? "wss:" : "ws:";
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(isDev ? ["'unsafe-eval'"] : [])],
    // Tailwind and React inline style attributes require 'unsafe-inline' for styles.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", supabase.origin, `${wsProtocol}//${supabase.host}`],
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
  };
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
