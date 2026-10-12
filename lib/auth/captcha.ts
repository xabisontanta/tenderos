import "server-only";

import { authEnv, type AuthEnv } from "@/lib/env";
import { createLogger } from "@/lib/log";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2048; // Cloudflare's documented maximum
const TIMEOUT_MS = 5000;

const log = createLogger({ module: "captcha" });

export type CaptchaResult = { ok: true } | { ok: false; reason: "missing" | "failed" | "unavailable" };

interface Options {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/**
 * Checks a Cloudflare Turnstile token with siteverify (CAPTCHA_MODE=app).
 * Does nothing when CAPTCHA is off, or when Supabase Auth verifies the token
 * itself (CAPTCHA_MODE=supabase). Fails closed: if Cloudflare cannot be
 * reached or answers with anything but `success: true`, the attempt is refused.
 * Tokens are single-use and live five minutes, so a token is never reused.
 */
export async function verifyCaptcha(token: FormDataEntryValue | null | undefined, opts: Options = {}): Promise<CaptchaResult> {
  let env: AuthEnv;
  try {
    env = authEnv(opts.env);
  } catch (error) {
    log.error("auth configuration is invalid", { reason: error instanceof Error ? error.message : "unknown" });
    return { ok: false, reason: "unavailable" };
  }
  if (env.captchaMode !== "app") return { ok: true };

  if (typeof token !== "string" || token.trim() === "" || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "missing" };

  // remoteip is optional and left out: it would send the visitor's address to
  // Cloudflare a second time, and the widget has already shown it to them.
  const body = new URLSearchParams({ secret: env.turnstileSecretKey!, response: token });

  let answer: unknown;
  try {
    const res = await (opts.fetchImpl ?? fetch)(SITEVERIFY_URL, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("siteverify answered with an error status", { status: res.status });
      return { ok: false, reason: "unavailable" };
    }
    answer = await res.json();
  } catch (error) {
    log.warn("siteverify unreachable or unreadable", { error: error instanceof Error ? error.name : "unknown" });
    return { ok: false, reason: "unavailable" };
  }

  const result = answer as { success?: unknown; "error-codes"?: unknown } | null;
  if (result && typeof result === "object" && result.success === true) return { ok: true };
  const codes = Array.isArray(result?.["error-codes"]) ? (result["error-codes"] as unknown[]).map(String) : [];
  if (codes.includes("internal-error")) return { ok: false, reason: "unavailable" };
  log.info("captcha refused", { codes });
  return { ok: false, reason: "failed" };
}
