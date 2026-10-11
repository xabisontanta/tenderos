import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requestHeaders: {} as Record<string, string>,
  signUp: vi.fn(),
  resetPasswordForEmail: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers(h.requestHeaders) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  getServerSupabase: async () => ({ auth: { signUp: h.signUp, resetPasswordForEmail: h.resetPasswordForEmail } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ getAdminSupabase: () => ({}) }));

const { signUp, requestPasswordReset } = await import("@/features/auth/actions");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

const signUpForm = { fullName: "Thandi Nkosi", email: "thandi@example.test", password: "correct-horse-battery-9" };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("APP_URL", "https://app.tenderos.example");
  h.requestHeaders = {};
  h.signUp.mockReset().mockResolvedValue({ data: { user: { id: "u1" }, session: null }, error: null });
  h.resetPasswordForEmail.mockReset().mockResolvedValue({ data: {}, error: null });
});

describe("auth links come from APP_URL", () => {
  it("sign-up ignores a forged Origin header", async () => {
    h.requestHeaders = { origin: "https://evil.example", host: "evil.example", "x-forwarded-host": "evil.example" };
    await signUp({}, form(signUpForm));
    const options = h.signUp.mock.calls[0][0].options;
    expect(options.emailRedirectTo).toBe("https://app.tenderos.example/auth/callback?next=%2Fonboarding");
    expect(JSON.stringify(h.signUp.mock.calls)).not.toContain("evil.example");
  });

  it("password reset ignores a forged Origin header", async () => {
    h.requestHeaders = { origin: "https://evil.example", host: "evil.example" };
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
