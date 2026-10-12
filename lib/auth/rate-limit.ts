import "server-only";

import { createHmac } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { authEnv, type AuthEnv } from "@/lib/env";
import { createLogger } from "@/lib/log";
import { getAdminSupabase } from "@/lib/supabase/admin";

/**
 * Limits on the unauthenticated auth actions. Supabase Auth has its own
 * limits, but every call we make comes from this server, so it sees one
 * address for all visitors: one attacker could use up the shared quota and
 * lock everyone out, and nothing limits guesses against one account. These
 * limits are per visitor address and per email.
 *
 * Personal data: addresses and emails never reach the database. The limiter
 * stores only HMAC-SHA256(AUTH_RATE_LIMIT_SECRET, "<kind>:<value>"), which
 * fits the key format of public.hit_rate_limit_key (service role only).
 */

const log = createLogger({ module: "auth-rate-limit" });

export type AuthAction = "signin" | "signup" | "reset" | "resend";

interface Limit {
  max: number;
  windowSeconds: number;
}

interface ActionLimits {
  ip: Limit;
  email: Limit;
  /**
   * A soft email limit asks for a CAPTCHA instead of blocking, so someone who
   * knows a victim's email cannot lock that person out by guessing. Without a
   * CAPTCHA configured it blocks like a hard one. Sign-up, reset and resend
   * stay hard: every attempt can send an email to the address.
   */
  emailSoft: boolean;
}

export const AUTH_LIMITS: Record<AuthAction, ActionLimits> = {
  signin: { ip: { max: 20, windowSeconds: 300 }, email: { max: 10, windowSeconds: 900 }, emailSoft: true },
  signup: { ip: { max: 5, windowSeconds: 3600 }, email: { max: 3, windowSeconds: 3600 }, emailSoft: false },
  reset: { ip: { max: 5, windowSeconds: 3600 }, email: { max: 3, windowSeconds: 3600 }, emailSoft: false },
  resend: { ip: { max: 5, windowSeconds: 3600 }, email: { max: 3, windowSeconds: 3600 }, emailSoft: false },
};

/** Expands an IPv6 address to its eight 16-bit groups. Input must already be valid. */
function ipv6Groups(address: string): number[] {
  let text = address;
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = text.includes("::") ? Array(8 - left.length - right.length).fill("0") : [];
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16));
}

/**
 * Normalises a client address for use as a limiter subject. IPv4 is kept; IPv6
 * collapses to its /64 so rotating through a prefix does not escape a limit;
 * IPv4-mapped IPv6 becomes IPv4. Returns null for anything that is not an address.
 */
function normaliseAddress(raw: string): string | null {
  let value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  if (isIPv4(value)) return value;
  if (!isIPv6(value)) return null;
  const groups = ipv6Groups(value);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/**
 * The visitor's address, read only from the header named in TRUSTED_IP_HEADER.
 * Nothing else is believed: X-Forwarded-For and friends are client-controlled
 * unless the platform overwrites them (Vercel does; see docs/auth.md). If the
 * header carries a list, the rightmost entry is used, because that is the one
 * our own edge added; a client can only add entries on the left.
 */
export function clientIp(headers: Headers, env: Record<string, string | undefined> = process.env): string | null {
  const name = authEnv(env).trustedIpHeader;
  if (!name) return null;
  const value = headers.get(name);
  if (!value) return null;
  const last = value.split(",").at(-1) ?? "";
  return normaliseAddress(last);
}

const hmacHex = (label: string, value: string, secret: string) => createHmac("sha256", secret).update(`${label}:${value}`).digest("hex");

/** HMAC-based limiter subject, shaped for public.hit_rate_limit_key: `auth_ip:<hex>` or `auth_email:<hex>`. */
export function rateLimitKey(kind: "ip" | "email", value: string, secret: string): string {
  return `auth_${kind}:${hmacHex(kind, value, secret)}`;
}

/**
 * Hash of the visitor's address to keep with a consent record (public.legal_acceptances.ip_hmac),
 * or null when the address is unknown. It is keyed under the same secret but in its own namespace,
 * so it cannot be matched against rate-limit keys, and it never contains the address. Misconfiguration
 * yields null: recording where consent came from must not stop the consent itself.
 */
export function consentOriginHmac(headers: Headers, env: Record<string, string | undefined> = process.env): string | null {
  try {
    const ip = clientIp(headers, env);
    return ip ? hmacHex("consent-ip", ip, authEnv(env).rateLimitSecret) : null;
  } catch {
    return null;
  }
}

export type AuthLimitResult = { ok: true; captchaRequired: boolean } | { ok: false; reason: "limited" | "unavailable" };

type HitOutcome = "ok" | "limited" | "error";

interface Deps {
  env: Record<string, string | undefined>;
  hit: (key: string, action: string, max: number, windowSeconds: number) => Promise<HitOutcome>;
}

async function hitDatabase(key: string, action: string, max: number, windowSeconds: number): Promise<HitOutcome> {
  const { error } = await getAdminSupabase().rpc("hit_rate_limit_key", { p_key: key, p_action: action, p_max: max, p_window_seconds: windowSeconds });
  if (!error) return "ok";
  // P0429 is the limiter saying "too many"; anything else means it could not answer.
  return error.code === "P0429" ? "limited" : "error";
}

/**
 * Counts one attempt against the visitor's address and the email, and decides
 * whether it may proceed and whether it must carry a CAPTCHA. The count is
 * made up front, so a refused attempt still counts. Fails closed: if the
 * limiter cannot answer, the attempt is refused rather than waved through.
 * With no trusted IP header (local development) only the email is limited.
 */
export async function limitAuthAttempt(
  action: AuthAction,
  request: { email: string; headers: Headers },
  deps: Deps = { env: process.env, hit: hitDatabase },
): Promise<AuthLimitResult> {
  let env: AuthEnv;
  try {
    env = authEnv(deps.env);
  } catch (error) {
    // A misconfigured deployment refuses auth attempts instead of running unprotected.
    log.error("auth configuration is invalid", { action, reason: error instanceof Error ? error.message : "unknown" });
    return { ok: false, reason: "unavailable" };
  }
  const limits = AUTH_LIMITS[action];
  const dbAction = `auth.${action}`;
  const ip = clientIp(request.headers, deps.env);
  if (!ip) log.warn("no client address; limiting by email only", { action });

  let ipOutcome: HitOutcome = "ok";
  let emailOutcome: HitOutcome;
  try {
    const email = request.email.trim().toLowerCase();
    [ipOutcome, emailOutcome] = await Promise.all([
      ip ? deps.hit(rateLimitKey("ip", ip, env.rateLimitSecret), dbAction, limits.ip.max, limits.ip.windowSeconds) : Promise.resolve<HitOutcome>("ok"),
      deps.hit(rateLimitKey("email", email, env.rateLimitSecret), dbAction, limits.email.max, limits.email.windowSeconds),
    ]);
  } catch (error) {
    log.error("rate limiter threw", { action, error: error instanceof Error ? error.name : "unknown" });
    return { ok: false, reason: "unavailable" };
  }

  if (ipOutcome === "error" || emailOutcome === "error") {
    log.error("rate limiter unavailable", { action });
    return { ok: false, reason: "unavailable" };
  }
  if (ipOutcome === "limited") return { ok: false, reason: "limited" };

  const canAskCaptcha = env.captchaMode !== "off";
  if (emailOutcome === "limited" && !(limits.emailSoft && canAskCaptcha)) return { ok: false, reason: "limited" };

  const captchaRequired = canAskCaptcha && (env.captchaMode === "supabase" || !limits.emailSoft || emailOutcome === "limited");
  return { ok: true, captchaRequired };
}
