import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { verifyCaptcha } = await import("@/lib/auth/captcha");
const { captchaClientConfig } = await import("@/lib/auth/captcha-config");

const appEnv = { CAPTCHA_MODE: "app", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "the-secret" };

function fetchReturning(body: unknown, init: { status?: number; json?: boolean } = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const text = init.json === false ? String(body) : JSON.stringify(body);
    return new Response(text, { status: init.status ?? 200, headers: { "content-type": "application/json" } });
  });
}

describe("captchaClientConfig", () => {
  it("returns nothing while off or not fully configured", () => {
    expect(captchaClientConfig({})).toBeNull();
    expect(captchaClientConfig({ CAPTCHA_MODE: "off", TURNSTILE_SITE_KEY: "site" })).toBeNull();
    expect(captchaClientConfig({ CAPTCHA_MODE: "app" })).toBeNull();
  });

  it("returns the mode and the public site key, never the secret", () => {
    expect(captchaClientConfig(appEnv)).toEqual({ mode: "app", siteKey: "site" });
    expect(captchaClientConfig({ CAPTCHA_MODE: "supabase", TURNSTILE_SITE_KEY: "site" })).toEqual({ mode: "supabase", siteKey: "site" });
  });
});

describe("verifyCaptcha", () => {
  it("does nothing when the mode is off, so the form works without Turnstile", async () => {
    const fetchImpl = fetchReturning({ success: false });
    expect(await verifyCaptcha(undefined, { env: {}, fetchImpl })).toEqual({ ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does nothing in supabase mode: Supabase checks the token itself", async () => {
    const fetchImpl = fetchReturning({ success: false });
    expect(await verifyCaptcha("tok", { env: { CAPTCHA_MODE: "supabase", TURNSTILE_SITE_KEY: "site" }, fetchImpl })).toEqual({ ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the secret and token to siteverify and accepts success", async () => {
    const fetchImpl = fetchReturning({ success: true, hostname: "app.tenderos.example", "error-codes": [] });
    const result = await verifyCaptcha("token-123", { env: appEnv, fetchImpl });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init?.method).toBe("POST");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("secret")).toBe("the-secret");
    expect(body.get("response")).toBe("token-123");
    // The visitor's address is not forwarded to Cloudflare.
    expect(body.has("remoteip")).toBe(false);
  });

  it("rejects a missing, blank or oversized token without calling Cloudflare", async () => {
    const fetchImpl = fetchReturning({ success: true });
    for (const token of [undefined, null, "", "   ", "x".repeat(2049)]) {
      expect(await verifyCaptcha(token, { env: appEnv, fetchImpl })).toEqual({ ok: false, reason: "missing" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a failed or replayed token", async () => {
    expect(await verifyCaptcha("t", { env: appEnv, fetchImpl: fetchReturning({ success: false, "error-codes": ["invalid-input-response"] }) })).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(await verifyCaptcha("t", { env: appEnv, fetchImpl: fetchReturning({ success: false, "error-codes": ["timeout-or-duplicate"] }) })).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("only accepts an explicit success: true", async () => {
    for (const body of [{}, { success: "true" }, { success: 1 }, [], null]) {
      expect(await verifyCaptcha("t", { env: appEnv, fetchImpl: fetchReturning(body) }), JSON.stringify(body)).toEqual({ ok: false, reason: "failed" });
    }
  });

  it("fails closed when Cloudflare cannot be reached or answers badly", async () => {
    const down = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await verifyCaptcha("t", { env: appEnv, fetchImpl: down })).toEqual({ ok: false, reason: "unavailable" });
    expect(await verifyCaptcha("t", { env: appEnv, fetchImpl: fetchReturning({}, { status: 500 }) })).toEqual({ ok: false, reason: "unavailable" });
    expect(await verifyCaptcha("t", { env: appEnv, fetchImpl: fetchReturning("<html>", { json: false }) })).toEqual({ ok: false, reason: "unavailable" });
    expect(await verifyCaptcha("t", { env: appEnv, fetchImpl: fetchReturning({ success: false, "error-codes": ["internal-error"] }) })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});
