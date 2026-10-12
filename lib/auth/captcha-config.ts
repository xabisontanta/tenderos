import type { CaptchaMode } from "@/lib/env";

type Env = Record<string, string | undefined>;

/**
 * What the browser and the CSP need to know about CAPTCHA: the mode and the
 * public Turnstile site key. Null while it is off or not fully set up, so the
 * forms render without a widget. Never carries the secret key. Safe to import
 * from the middleware: it reads plain values and validates nothing (authEnv
 * does that on the server paths that act on the mode).
 */
export function captchaClientConfig(env: Env = process.env): { mode: Exclude<CaptchaMode, "off">; siteKey: string } | null {
  const mode = env.CAPTCHA_MODE?.trim();
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  if ((mode !== "app" && mode !== "supabase") || !siteKey) return null;
  if (mode === "app" && !env.TURNSTILE_SECRET_KEY?.trim()) return null;
  return { mode, siteKey };
}
