import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { clientIp, rateLimitKey, limitAuthAttempt, AUTH_LIMITS } = await import("@/lib/auth/rate-limit");

// Same pattern as public.hit_rate_limit_key (migration 015).
const KEY_PATTERN = /^[a-z][a-z0-9_]{2,30}:[A-Za-z0-9-]{1,64}$/;
const secret = "s".repeat(40);
const baseEnv = { AUTH_RATE_LIMIT_SECRET: secret, TRUSTED_IP_HEADER: "x-vercel-forwarded-for" };

const headers = (h: Record<string, string>) => new Headers(h);

describe("clientIp", () => {
  it("reads only the configured header", () => {
    const h = headers({ "x-vercel-forwarded-for": "41.0.0.9", "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" });
    expect(clientIp(h, baseEnv)).toBe("41.0.0.9");
  });

  it("returns null when no header is configured, even if a forwarded header is present", () => {
    expect(clientIp(headers({ "x-forwarded-for": "6.6.6.6" }), { AUTH_RATE_LIMIT_SECRET: secret })).toBeNull();
  });

  it("returns null when the configured header is missing or not an address", () => {
    expect(clientIp(headers({}), baseEnv)).toBeNull();
    expect(clientIp(headers({ "x-vercel-forwarded-for": "not-an-ip" }), baseEnv)).toBeNull();
    expect(clientIp(headers({ "x-vercel-forwarded-for": "" }), baseEnv)).toBeNull();
  });

  it("takes the rightmost entry of a list: that one was added by the trusted edge", () => {
    expect(clientIp(headers({ "x-vercel-forwarded-for": "6.6.6.6, 41.0.0.9" }), baseEnv)).toBe("41.0.0.9");
  });

  it("maps an IPv4-mapped IPv6 address to IPv4", () => {
    expect(clientIp(headers({ "x-vercel-forwarded-for": "::ffff:41.0.0.9" }), baseEnv)).toBe("41.0.0.9");
  });

  it("groups IPv6 addresses by /64 so an attacker cannot rotate through a whole prefix", () => {
    const a = clientIp(headers({ "x-vercel-forwarded-for": "2001:db8:abcd:12::1" }), baseEnv);
    const b = clientIp(headers({ "x-vercel-forwarded-for": "2001:0db8:abcd:0012:ffff:ffff:ffff:ffff" }), baseEnv);
    const c = clientIp(headers({ "x-vercel-forwarded-for": "2001:db8:abcd:13::1" }), baseEnv);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("accepts a bracketed or zoned IPv6 value", () => {
    const plain = clientIp(headers({ "x-vercel-forwarded-for": "2001:db8::1" }), baseEnv);
    expect(clientIp(headers({ "x-vercel-forwarded-for": "[2001:db8::1]" }), baseEnv)).toBe(plain);
    expect(clientIp(headers({ "x-vercel-forwarded-for": "fe80::1%eth0" }), baseEnv)).not.toBeNull();
  });
});

describe("rateLimitKey", () => {
  it("is a keyed hash that fits hit_rate_limit_key and never contains the input", () => {
    const ip = rateLimitKey("ip", "41.0.0.9", secret);
    const email = rateLimitKey("email", "thandi@example.test", secret);
    expect(ip).toMatch(KEY_PATTERN);
    expect(email).toMatch(KEY_PATTERN);
    expect(ip).toMatch(/^auth_ip:[0-9a-f]{64}$/);
    expect(email).toMatch(/^auth_email:[0-9a-f]{64}$/);
    expect(ip).not.toContain("41.0.0.9");
    expect(email).not.toContain("thandi");
  });

  it("is stable, depends on the secret, and separates IPs from emails", () => {
    expect(rateLimitKey("ip", "41.0.0.9", secret)).toBe(rateLimitKey("ip", "41.0.0.9", secret));
    expect(rateLimitKey("ip", "41.0.0.9", secret)).not.toBe(rateLimitKey("ip", "41.0.0.9", "t".repeat(40)));
    expect(rateLimitKey("ip", "same", secret).split(":")[1]).not.toBe(rateLimitKey("email", "same", secret).split(":")[1]);
  });
});

function fakeDeps(outcomes: Record<string, "ok" | "limited" | "error"> = {}, env: Record<string, string> = baseEnv) {
  const calls: Array<{ key: string; action: string; max: number; windowSeconds: number }> = [];
  return {
    calls,
    deps: {
      env,
      hit: async (key: string, action: string, max: number, windowSeconds: number) => {
        calls.push({ key, action, max, windowSeconds });
        return outcomes[key.split(":")[0]] ?? "ok";
      },
    },
  };
}

const request = { email: "thandi@example.test", headers: headers({ "x-vercel-forwarded-for": "41.0.0.9" }) };

describe("limitAuthAttempt", () => {
  it("checks the address and the email, using hashes only", async () => {
    const { calls, deps } = fakeDeps();
    expect(await limitAuthAttempt("signin", request, deps)).toEqual({ ok: true, captchaRequired: false });
    expect(calls.map((c) => c.key.split(":")[0]).sort()).toEqual(["auth_email", "auth_ip"]);
    expect(JSON.stringify(calls)).not.toContain("thandi");
    expect(JSON.stringify(calls)).not.toContain("41.0.0.9");
    for (const c of calls) {
      expect(c.key).toMatch(KEY_PATTERN);
      expect(c.action).toBe("auth.signin");
    }
  });

  it("uses the documented limits", () => {
    expect(AUTH_LIMITS.signin).toMatchObject({ ip: { max: 20, windowSeconds: 300 }, email: { max: 10, windowSeconds: 900 } });
    expect(AUTH_LIMITS.signup).toMatchObject({ ip: { max: 5, windowSeconds: 3600 }, email: { max: 3, windowSeconds: 3600 } });
    expect(AUTH_LIMITS.reset).toMatchObject({ ip: { max: 5, windowSeconds: 3600 }, email: { max: 3, windowSeconds: 3600 } });
    for (const l of Object.values(AUTH_LIMITS)) {
      expect(l.ip.windowSeconds).toBeLessThanOrEqual(3600);
      expect(l.email.windowSeconds).toBeLessThanOrEqual(3600);
    }
  });

  it("blocks when the address is over its limit", async () => {
    const { deps } = fakeDeps({ auth_ip: "limited" });
    expect(await limitAuthAttempt("signin", request, deps)).toEqual({ ok: false, reason: "limited" });
  });

  it("blocks sign-up and reset when the email is over its limit", async () => {
    for (const action of ["signup", "reset", "resend"] as const) {
      const { deps } = fakeDeps({ auth_email: "limited" });
      expect(await limitAuthAttempt(action, request, deps), action).toEqual({ ok: false, reason: "limited" });
    }
  });

  it("blocks sign-in over the email limit when no CAPTCHA can be asked for", async () => {
    const { deps } = fakeDeps({ auth_email: "limited" });
    expect(await limitAuthAttempt("signin", request, deps)).toEqual({ ok: false, reason: "limited" });
  });

  it("escalates sign-in over the email limit to a CAPTCHA instead of locking the account out", async () => {
    const env = { ...baseEnv, CAPTCHA_MODE: "app", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" };
    const { deps } = fakeDeps({ auth_email: "limited" }, env);
    expect(await limitAuthAttempt("signin", request, deps)).toEqual({ ok: true, captchaRequired: true });
  });

  it("never lets the address limit be escalated away", async () => {
    const env = { ...baseEnv, CAPTCHA_MODE: "app", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" };
    const { deps } = fakeDeps({ auth_ip: "limited" }, env);
    expect(await limitAuthAttempt("signin", request, deps)).toEqual({ ok: false, reason: "limited" });
  });

  it("always asks for a CAPTCHA on sign-up and reset when one is configured", async () => {
    const env = { ...baseEnv, CAPTCHA_MODE: "app", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" };
    for (const action of ["signup", "reset", "resend"] as const) {
      expect(await limitAuthAttempt(action, request, fakeDeps({}, env).deps), action).toEqual({ ok: true, captchaRequired: true });
    }
    expect(await limitAuthAttempt("signin", request, fakeDeps({}, env).deps)).toEqual({ ok: true, captchaRequired: false });
  });

  it("asks for a CAPTCHA every time when Supabase enforces it", async () => {
    const env = { ...baseEnv, CAPTCHA_MODE: "supabase", TURNSTILE_SITE_KEY: "site" };
    expect(await limitAuthAttempt("signin", request, fakeDeps({}, env).deps)).toEqual({ ok: true, captchaRequired: true });
  });

  it("fails closed when the limiter cannot be reached", async () => {
    expect(await limitAuthAttempt("signin", request, fakeDeps({ auth_ip: "error" }).deps)).toEqual({ ok: false, reason: "unavailable" });
    expect(await limitAuthAttempt("signup", request, fakeDeps({ auth_email: "error" }).deps)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("fails closed when the limiter throws", async () => {
    const deps = {
      env: baseEnv,
      hit: async () => {
        throw new Error("network down");
      },
    };
    expect(await limitAuthAttempt("signin", request, deps)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("still limits by email when the address is unknown", async () => {
    const { calls, deps } = fakeDeps();
    await limitAuthAttempt("signup", { email: request.email, headers: headers({}) }, deps);
    expect(calls.map((c) => c.key.split(":")[0])).toEqual(["auth_email"]);
  });

  it("normalises the email before hashing", async () => {
    const a = fakeDeps();
    const b = fakeDeps();
    await limitAuthAttempt("reset", { email: "Thandi@Example.test ", headers: request.headers }, a.deps);
    await limitAuthAttempt("reset", { email: "thandi@example.test", headers: request.headers }, b.deps);
    expect(a.calls.find((c) => c.key.startsWith("auth_email"))!.key).toBe(b.calls.find((c) => c.key.startsWith("auth_email"))!.key);
  });
});
