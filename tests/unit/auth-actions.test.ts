import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requestHeaders: {} as Record<string, string>,
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  resend: vi.fn(),
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
    auth: { signUp: h.signUp, signInWithPassword: h.signInWithPassword, resetPasswordForEmail: h.resetPasswordForEmail, resend: h.resend },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ getAdminSupabase: () => ({ rpc: h.rpc }) }));

const { signIn, signUp, requestPasswordReset, resendConfirmation } = await import("@/features/auth/actions");

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
  h.resend.mockReset().mockResolvedValue({ data: {}, error: null });
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

describe("sign-up never reveals whether an address is registered", () => {
  const outcomes: Array<[string, unknown]> = [
    ["a new address (confirmation email sent)", { data: { user: { id: "new", identities: [{}] }, session: null }, error: null }],
    ["an address already registered (Supabase returns an obfuscated user)", { data: { user: { id: "fake", identities: [] }, session: null }, error: null }],
    [
      "an address already registered (error from Supabase)",
      { data: { user: null, session: null }, error: { status: 422, code: "user_already_exists", message: "User already registered" } },
    ],
    [
      "an address that was just sent a confirmation",
      { data: { user: null, session: null }, error: { status: 429, code: "over_email_send_rate_limit", message: "email rate limit exceeded" } },
    ],
  ];

  it.each(outcomes)("gives one answer for %s", async (_name, response) => {
    h.signUp.mockResolvedValue(response);
    const state = await signUp({}, form(signUpForm));
    expect(state.error).toBeUndefined();
    expect(state.code).toBe("confirmation_sent");
    expect(state.values).toEqual({ fullName: "Thandi Nkosi", email: "thandi@example.test" });
    expect(state.message).toBe("Check your email to confirm your account. If you already have an account, sign in or reset your password instead.");
  });

  it("returns exactly the same state for every outcome", async () => {
    const states = [];
    for (const [, response] of outcomes) {
      h.signUp.mockResolvedValue(response);
      states.push(await signUp({}, form(signUpForm)));
    }
    for (const state of states) expect(state).toEqual(states[0]);
  });

  it("still tells the visitor about an unrelated failure", async () => {
    h.signUp.mockResolvedValue({ data: { user: null, session: null }, error: { status: 500, code: "unexpected_failure", message: "boom" } });
    expect((await signUp({}, form(signUpForm))).error).toBe("Could not create the account");
    h.signUp.mockResolvedValue({ data: { user: null, session: null }, error: { status: 429, code: "over_request_rate_limit", message: "slow down" } });
    expect((await signUp({}, form(signUpForm))).error).toMatch(/too many attempts/i);
  });

  it("goes straight to onboarding only when the server confirmed the address itself (development without confirmations)", async () => {
    h.signUp.mockResolvedValue({ data: { user: { id: "u" }, session: { access_token: "x" } }, error: null });
    await expect(signUp({}, form(signUpForm))).rejects.toThrow("NEXT_REDIRECT:/onboarding");
  });
});

describe("sign-in with an unconfirmed address", () => {
  it("says the address is not confirmed and offers to resend", async () => {
    h.signInWithPassword.mockResolvedValue({ data: {}, error: { status: 400, code: "email_not_confirmed", message: "Email not confirmed" } });
    const state = await signIn({}, form(signInForm));
    expect(state.code).toBe("email_not_confirmed");
    expect(state.error).toMatch(/confirm your email/i);
    expect(state.values).toEqual({ email: "thandi@example.test" });
  });
});

describe("resendConfirmation", () => {
  const generic = "If that address is waiting for confirmation, a new link is on its way.";

  it("asks Supabase to resend the signup email, with a link on APP_URL", async () => {
    const state = await resendConfirmation({}, form({ email: "thandi@example.test" }));
    expect(h.resend).toHaveBeenCalledWith({
      type: "signup",
      email: "thandi@example.test",
      options: { emailRedirectTo: "https://app.tenderos.example/auth/callback?next=%2Fonboarding" },
    });
    expect(state.message).toBe(generic);
  });

  it("gives the same answer whatever Supabase says", async () => {
    for (const error of [null, { status: 429, code: "over_email_send_rate_limit" }, { status: 400, code: "user_not_found" }, { status: 500, code: "x" }]) {
      h.resend.mockResolvedValue({ data: {}, error });
      expect(await resendConfirmation({}, form({ email: "thandi@example.test" }))).toEqual({
        message: generic,
        code: "confirmation_sent",
        values: { email: "thandi@example.test" },
      });
    }
  });

  it("is limited per address and per email, under its own action name", async () => {
    await resendConfirmation({}, form({ email: "thandi@example.test" }));
    expect(h.rpc.mock.calls.map(([, args]) => args.p_action)).toEqual(["auth.resend", "auth.resend"]);
    h.rpc.mockResolvedValue({ data: null, error: { code: "P0429", message: "Too many requests" } });
    h.resend.mockClear();
    const state = await resendConfirmation({}, form({ email: "thandi@example.test" }));
    expect(state.error).toMatch(/too many attempts/i);
    expect(h.resend).not.toHaveBeenCalled();
  });

  it("validates the email first", async () => {
    const state = await resendConfirmation({}, form({ email: "nope" }));
    expect(state.fieldErrors?.email).toBeTruthy();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.resend).not.toHaveBeenCalled();
  });

  it("needs a CAPTCHA token when one is configured", async () => {
    for (const [k, v] of Object.entries(turnstileEnv)) vi.stubEnv(k, v);
    stubSiteverify();
    expect((await resendConfirmation({}, form({ email: "thandi@example.test" }))).error).toMatch(/security check/i);
    expect(h.resend).not.toHaveBeenCalled();
    await resendConfirmation({}, form({ email: "thandi@example.test", "cf-turnstile-response": "tok" }));
    expect(h.resend).toHaveBeenCalledTimes(1);
  });
});
