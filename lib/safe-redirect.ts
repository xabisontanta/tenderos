/**
 * Returns a same-site path to redirect to after sign-in, or "/". Rejects
 * anything a browser could read as another origin: protocol-relative
 * ("//evil.com"), backslash tricks ("/\evil.com"), control characters and
 * absolute URLs.
 */
export function safeRedirectPath(next: unknown): string {
  if (typeof next !== "string" || next.length > 2000) return "/";
  if (!next.startsWith("/") || next.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(next)) return "/";
  try {
    const base = "https://tenderos.invalid";
    const url = new URL(next, base);
    if (url.origin !== base) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
