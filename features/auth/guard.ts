import "server-only";

import { headers } from "next/headers";
import { verifyCaptcha } from "@/lib/auth/captcha";
import { limitAuthAttempt, type AuthAction } from "@/lib/auth/rate-limit";
import { authEnv } from "@/lib/env";

/** Name of the hidden input the Turnstile widget fills in. */
export const TURNSTILE_FIELD = "cf-turnstile-response";

export const GUARD_MESSAGES = {
  limited: "Too many attempts. Wait a few minutes and try again.",
  unavailable: "This service is temporarily unavailable. Try again in a minute.",
  captcha: "Please complete the security check and try again.",
} as const;

export type Guard = { ok: true; captchaToken?: string } | { ok: false; error: string };

/**
 * Everything an unauthenticated auth action does before it touches Supabase
 * Auth: count the attempt against the visitor's address and the email, and
 * check the CAPTCHA when one is due. Call it after the cheap input validation
 * and before anything that sends an email or checks a password.
 *
 * In CAPTCHA_MODE=supabase the returned token goes to Supabase Auth as
 * `captchaToken`; in CAPTCHA_MODE=app it has already been verified here.
 */
export async function guardAuthAttempt(action: AuthAction, email: string, formData: FormData): Promise<Guard> {
  const limit = await limitAuthAttempt(action, { email, headers: await headers() });
  if (!limit.ok) return { ok: false, error: GUARD_MESSAGES[limit.reason] };
  if (!limit.captchaRequired) return { ok: true };

  const token = formData.get(TURNSTILE_FIELD);
  let mode: string;
  try {
    mode = authEnv().captchaMode;
  } catch {
    return { ok: false, error: GUARD_MESSAGES.unavailable };
  }
  if (mode === "supabase") {
    if (typeof token !== "string" || token.trim() === "") return { ok: false, error: GUARD_MESSAGES.captcha };
    return { ok: true, captchaToken: token };
  }
  const captcha = await verifyCaptcha(token);
  if (captcha.ok) return { ok: true };
  return { ok: false, error: captcha.reason === "unavailable" ? GUARD_MESSAGES.unavailable : GUARD_MESSAGES.captcha };
}
