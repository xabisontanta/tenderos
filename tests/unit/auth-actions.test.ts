import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requestHeaders: {} as Record<string, string>,
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers(h.requestHeaders) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  getServerSupabase: async () => ({
    auth: { signUp: h.signUp, signInWithPassword: h.signInWithPassword, resetPasswordForEmail: h.resetPasswordForEmail },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ getAdminSupabase: () => ({ rpc: h.rpc }) }));

const { signIn, signUp, requestPasswordReset } = await import("@/features/auth/actions");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

const signUpForm = { fullName: "Thandi Nkosi", email: "thandi@example.test", password: "correct-horse-battery-9" };
const signInForm = { email: "thandi@example.test", password: "correct-horse-battery-9" };
const turnstileEnv = { CAPTCHA_MODE: "app", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "the-secret" };

function stubSiteverify(result: unknown = { success: true }) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(result), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv("APP_URL", "https://app.tenderos.example");
  vi.stubEnv("AUTH_RATE_LIMIT_SECRET", "k".repeat(40));
  vi.stubEnv("TRUSTED_IP_HEADER", "x-vercel-forwarded-for");
  h.requestHeaders = { "x-vercel-forwarded-for": "41.0.0.9" };
  h.signUp.mockReset().mockResolvedValue({ data: { user: { id: "u1" }, session: null }, error: null });
  h.signInWithPassword.mockReset().mockResolvedValue({ data: {}, error: null });
  h.resetPasswordForEmail.mockReset().mockResolvedValue({ data: {}, error: null });
  h.rpc.mockReset().mockResolvedValue({ data: null, error: null });
});

describe("auth links come from APP_URL", () => {
  it("sign-up ignores a forged Origin header", async () => {
    h.requestHeaders = { ...h.requestHeaders, origin: "https://evil.example", host: "evil.example", "x-forwarded-host": "evil.example" };
    await signUp({}, form(signUpForm));
    const options = h.signUp.mock.calls[0][0].options;
    expect(options.emailRedirectTo).toBe("https://app.tenderos.example/auth/callback?next=%2Fonboarding");
    expect(JSON.stringify(h.signUp.mock.calls)).not.toContain("evil.example");
  });

  it("password reset ignores a forged Origin header", async () => {
    h.requestHeaders = { ...h.requestHeaders, origin: "https://evil.example", host: "evil.example" };
    await requestPasswordReset({}, form({ email: "thandi@example.test" }));
    expect(h.resetPasswordForEmail).toHaveBeenCalledWith("thandi@example.test", {
      redirectTo: "https://app.tenderos.example/auth/callback?next=%2Freset-password",
    });
  });

  it("uses a clean origin when APP_URL has a trailing slash", async () => {
    vi.stubEnv("APP_URL", "https://app.tenderos.example/");
    await requestPasswordReset({}, form({ email: "thandi@example.test" }));
    expect(h.resetPasswordForEmail.mock.calls[0][1].redirectTo).toBe("https://app.tenderos.example/auth/callback?next=%2Freset-password");
  });
});

describe("app-level rate limits", () => {
  it("sign-in is limited by address and by email before Supabase Auth is called", async () => {
    await expect(signIn({}, form(signInForm))).rejects.toThrow("NEXT_REDIRECT:/");
    const keys = h.rpc.mock.calls.map(([name, args]) => `${name}:${args.p_key.split(":")[0]}:${args.p_action}`).sort();
    expect(keys).toEqual(["hit_rate_limit_key:auth_email:auth.signin", "hit_rate_limit_key:auth_ip:auth.signin"]);
    expect(h.signInWithPassword).toHaveBeenCalledTimes(1);
  });

  it("never sends the raw email or address to the database", async () => {
    await signIn({}, form(signInForm)).catch(() => {});
    expect(JSON.stringify(h.rpc.mock.calls)).not.toContain("thandi");
    expect(JSON.stringify(h.rpc.mock.calls)).not.toContain("41.0.0.9");
  });

  it("refuses a sign-in over the address limit without calling Supabase Auth", async () => {
    h.rpc.mockImplementation(async (_n: string, args: { p_key: string }) =>
      args.p_key.startsWith("auth_ip:") ? { data: null, error: { code: "P0429", message: "Too many requests" } } : { data: null, error: null },
    );
    const state = await signIn({}, form(signInForm));
    expect(state.error).toMatch(/too many attempts/i);
    expect(h.signInWithPassword).not.toHaveBeenCalled();
  });

  it("fails closed when the limiter is unavailable", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "08006", message: "connection failure" } });
    const state = await signIn({}, form(signInForm));
    expect(state.error).toMatch(/temporarily unavailable/i);
    expect(h.signInWithPassword).not.toHaveBeenCalled();
    h.rpc.mockRejectedValue(new Error("boom"));
    expect((await signUp({}, form(signUpForm))).error).toMatch(/temporarily unavailable/i);
    expect(h.signUp).not.toHaveBeenCalled();
  });

  it("sign-up and password reset are limited too", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "P0429", message: "Too many requests" } });
    expect((await signUp({}, form(signUpForm))).error).toMatch(/too many attempts/i);
    expect((await requestPasswordReset({}, form({ email: "thandi@example.test" }))).error).toMatch(/too many attempts/i);
    expect(h.signUp).not.toHaveBeenCalled();
    expect(h.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(h.rpc.mock.calls.every(([, args]) => ["auth.signup", "auth.reset"].includes(args.p_action))).toBe(true);
  });

  it("does not touch the database for input that fails validation", async () => {
    await signIn({}, form({ email: "not-an-email", password: "x" }));
    await signUp({}, form({ ...signUpForm, password: "short" }));
    await requestPasswordReset({}, form({ email: "" }));
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("CAPTCHA", () => {
  it("is not required while CAPTCHA_MODE is off", async () => {
    const fetchMock = stubSiteverify();
    await signUp({}, form(signUpForm));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.signUp).toHaveBeenCalledTimes(1);
  });

  it("sign-up verifies the Turnstile token with Cloudflare first", async () => {
    for (const [k, v] of Object.entries(turnstileEnv)) vi.stubEnv(k, v);
    const fetchMock = stubSiteverify();
    await signUp({}, form({ ...signUpForm, "cf-turnstile-response": "tok-1" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.signUp).toHaveBeenCalledTimes(1);
  });

  it("sign-up without a token, or with a failed one, does not reach Supabase Auth", async () => {
    for (const [k, v] of Object.entries(turnstileEnv)) vi.stubEnv(k, v);
    stubSiteverify({ success: false, "error-codes": ["invalid-input-response"] });
    const missing = await signUp({}, form(signUpForm));
    const failed = await signUp({}, form({ ...signUpForm, "cf-turnstile-response": "bad" }));
    expect(missing.error).toMatch(/security check/i);
    expect(failed.error).toMatch(/security check/i);
    expect(h.signUp).not.toHaveBeenCalled();
  });

  it("sign-in only asks for a token once the email has been tried too often", async () => {
    for (const [k, v] of Object.entries(turnstileEnv)) vi.stubEnv(k, v);
    const fetchMock = stubSiteverify();
    await signIn({}, form(signInForm)).catch(() => {});
    expect(fetchMock).not.toHaveBeenCalled();

    h.rpc.mockImplementation(async (_n: string, args: { p_key: string }) =>
      args.p_key.startsWith("auth_email:") ? { data: null, error: { code: "P0429", message: "Too many requests" } } : { data: null, error: null },
    );
    h.signInWithPassword.mockClear();
    const withoutToken = await signIn({}, form(signInForm));
    expect(withoutToken.error).toMatch(/security check/i);
    expect(h.signInWithPassword).not.toHaveBeenCalled();
    await signIn({}, form({ ...signInForm, "cf-turnstile-response": "tok" })).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.signInWithPassword).toHaveBeenCalledTimes(1);
  });

  it("in supabase mode forwards the token to Supabase Auth, which verifies it", async () => {
    vi.stubEnv("CAPTCHA_MODE", "supabase");
    vi.stubEnv("TURNSTILE_SITE_KEY", "site");
    const fetchMock = stubSiteverify();
    await signUp({}, form({ ...signUpForm, "cf-turnstile-response": "tok-9" }));
    expect(h.signUp.mock.calls[0][0].options.captchaToken).toBe("tok-9");
    await requestPasswordReset({}, form({ email: "thandi@example.test", "cf-turnstile-response": "tok-10" }));
    expect(h.resetPasswordForEmail.mock.calls[0][1].captchaToken).toBe("tok-10");
    expect(fetchMock).not.toHaveBeenCalled();
    h.signUp.mockClear();
    expect((await signUp({}, form(signUpForm))).error).toMatch(/security check/i);
    expect(h.signUp).not.toHaveBeenCalled();
  });
});

describe("form state", () => {
  it("returns field errors and keeps the submitted values, never the password", async () => {
    const state = await signUp({}, form({ fullName: "T", email: "thandi@example.test", password: "short" }));
    expect(state.fieldErrors).toMatchObject({ fullName: expect.any(String), password: expect.any(String) });
    expect(state.fieldErrors).not.toHaveProperty("email");
    expect(state.values).toEqual({ fullName: "T", email: "thandi@example.test" });
    expect(JSON.stringify(state)).not.toContain("short");
  });

  it("keeps the email after a failed sign-in", async () => {
    h.signInWithPassword.mockResolvedValue({ data: {}, error: { status: 400, message: "Invalid login credentials" } });
    const state = await signIn({}, form(signInForm));
    expect(state.error).toBe("Invalid email or password");
    expect(state.values).toEqual({ email: "thandi@example.test" });
    expect(JSON.stringify(state)).not.toContain("correct-horse");
  });

  it("keeps the email after a rejected reset request", async () => {
    const state = await requestPasswordReset({}, form({ email: "nope" }));
    expect(state.fieldErrors?.email).toBeTruthy();
    expect(state.values).toEqual({ email: "nope" });
  });
});
