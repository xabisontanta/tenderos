import { describe, expect, it } from "vitest";
import { authEnv } from "@/lib/env";

const secret = "a".repeat(32);
const production = { NODE_ENV: "production", AUTH_RATE_LIMIT_SECRET: secret, TRUSTED_IP_HEADER: "x-vercel-forwarded-for" };

describe("authEnv", () => {
  it("works with nothing configured outside production", () => {
    const env = authEnv({});
    expect(env.captchaMode).toBe("off");
    expect(env.trustedIpHeader).toBeNull();
    expect(env.turnstileSiteKey).toBeNull();
    expect(env.rateLimitSecret.length).toBeGreaterThanOrEqual(32);
  });

  it("treats blank placeholders from .env files as unset", () => {
    const env = authEnv({ AUTH_RATE_LIMIT_SECRET: "", TRUSTED_IP_HEADER: "  ", CAPTCHA_MODE: "", TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "" });
    expect(env).toMatchObject({ captchaMode: "off", trustedIpHeader: null, turnstileSiteKey: null, turnstileSecretKey: null });
  });

  it("requires the HMAC secret and the trusted IP header in production", () => {
    expect(() => authEnv({ NODE_ENV: "production", TRUSTED_IP_HEADER: "x-real-ip" })).toThrow(/AUTH_RATE_LIMIT_SECRET is required in production/);
    expect(() => authEnv({ NODE_ENV: "production", AUTH_RATE_LIMIT_SECRET: secret })).toThrow(/TRUSTED_IP_HEADER is required in production/);
    expect(authEnv(production).trustedIpHeader).toBe("x-vercel-forwarded-for");
  });

  it("defaults the header on Vercel and derives the secret from the service role key", () => {
    const serviceKey = "service-role-key-".padEnd(48, "x");
    const env = authEnv({ NODE_ENV: "production", VERCEL: "1", SUPABASE_SERVICE_ROLE_KEY: serviceKey });
    expect(env.trustedIpHeader).toBe("x-vercel-forwarded-for");
    expect(env.rateLimitSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(env.rateLimitSecret).not.toContain(serviceKey);
    expect(authEnv({ NODE_ENV: "production", VERCEL: "1", SUPABASE_SERVICE_ROLE_KEY: serviceKey }).rateLimitSecret).toBe(env.rateLimitSecret);
    expect(authEnv({ NODE_ENV: "production", VERCEL: "1", SUPABASE_SERVICE_ROLE_KEY: serviceKey.replace(/x$/, "y") }).rateLimitSecret).not.toBe(
      env.rateLimitSecret,
    );
  });

  it("lets explicit values win over the platform defaults", () => {
    const env = authEnv({ ...production, VERCEL: "1", TRUSTED_IP_HEADER: "cf-connecting-ip", SUPABASE_SERVICE_ROLE_KEY: "k".repeat(48) });
    expect(env).toMatchObject({ trustedIpHeader: "cf-connecting-ip", rateLimitSecret: secret });
  });

  it("does not derive a secret from a missing or short service role key, or outside production", () => {
    expect(() => authEnv({ NODE_ENV: "production", VERCEL: "1" })).toThrow(/AUTH_RATE_LIMIT_SECRET is required in production/);
    expect(() => authEnv({ NODE_ENV: "production", VERCEL: "1", SUPABASE_SERVICE_ROLE_KEY: "short" })).toThrow(/AUTH_RATE_LIMIT_SECRET is required/);
    expect(() => authEnv({ NODE_ENV: "production", SUPABASE_SERVICE_ROLE_KEY: "k".repeat(48) })).toThrow(/TRUSTED_IP_HEADER is required in production/);
    expect(authEnv({ SUPABASE_SERVICE_ROLE_KEY: "k".repeat(48) }).trustedIpHeader).toBeNull();
  });

  it("rejects a short secret and a malformed header name", () => {
    expect(() => authEnv({ AUTH_RATE_LIMIT_SECRET: "short" })).toThrow(/at least 32/);
    expect(() => authEnv({ TRUSTED_IP_HEADER: "x forwarded for" })).toThrow(/TRUSTED_IP_HEADER/);
  });

  it("lowercases the header name", () => {
    expect(authEnv({ TRUSTED_IP_HEADER: "CF-Connecting-IP" }).trustedIpHeader).toBe("cf-connecting-ip");
  });

  it("validates CAPTCHA_MODE and the keys each mode needs", () => {
    expect(() => authEnv({ CAPTCHA_MODE: "recaptcha" })).toThrow(/CAPTCHA_MODE/);
    expect(() => authEnv({ CAPTCHA_MODE: "app" })).toThrow(/TURNSTILE_SITE_KEY/);
    expect(() => authEnv({ CAPTCHA_MODE: "app", TURNSTILE_SITE_KEY: "site" })).toThrow(/TURNSTILE_SECRET_KEY/);
    expect(() => authEnv({ CAPTCHA_MODE: "supabase" })).toThrow(/TURNSTILE_SITE_KEY/);
    expect(authEnv({ CAPTCHA_MODE: "supabase", TURNSTILE_SITE_KEY: "site" }).captchaMode).toBe("supabase");
    expect(authEnv({ CAPTCHA_MODE: "app", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" })).toMatchObject({
      captchaMode: "app",
      turnstileSiteKey: "site",
      turnstileSecretKey: "secret",
    });
  });

  it("ignores Turnstile keys while the mode is off", () => {
    expect(authEnv({ TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" }).captchaMode).toBe("off");
  });
});
