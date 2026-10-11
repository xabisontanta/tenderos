import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({ verifyOtp: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: async () => ({ auth: { verifyOtp: h.verifyOtp } }) }));

const { GET } = await import("@/app/auth/confirm/route");

const call = (query: string) => GET(new NextRequest(`http://internal.local:3000/auth/confirm?${query}`));
const location = (res: Response) => new URL(res.headers.get("location")!);
const TOKEN = "a".repeat(40);

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("APP_URL", "https://app.tenderos.example");
  h.verifyOtp.mockReset().mockResolvedValue({ data: { session: {}, user: {} }, error: null });
});

describe("GET /auth/confirm (token_hash links, which work in any browser)", () => {
  it("verifies the hash and sends the visitor on, via APP_URL", async () => {
    const res = await call(`token_hash=${TOKEN}&type=email&next=/onboarding`);
    expect(h.verifyOtp).toHaveBeenCalledWith({ type: "email", token_hash: TOKEN });
    expect(location(res).href).toBe("https://app.tenderos.example/onboarding");
  });

  it("accepts the legacy signup type", async () => {
    await call(`token_hash=${TOKEN}&type=signup`);
    expect(h.verifyOtp).toHaveBeenCalledWith({ type: "signup", token_hash: TOKEN });
  });

  it("opens the new-password page after a recovery link when no next is given", async () => {
    const res = await call(`token_hash=${TOKEN}&type=recovery`);
    expect(location(res).pathname).toBe("/reset-password");
  });

  it("opens the dashboard after a plain confirmation", async () => {
    const res = await call(`token_hash=${TOKEN}&type=email`);
    expect(location(res).pathname).toBe("/");
  });

  it("never follows an unsafe next", async () => {
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      const res = await call(`token_hash=${TOKEN}&type=email&next=${encodeURIComponent(next)}`);
      expect(location(res).origin, next).toBe("https://app.tenderos.example");
      expect(location(res).pathname, next).toBe("/");
    }
  });

  it("sends an invalid, expired or already used link to sign-in with an error", async () => {
    h.verifyOtp.mockResolvedValue({ data: {}, error: { message: "Token has expired or is invalid", status: 403 } });
    const res = await call(`token_hash=${TOKEN}&type=email`);
    expect(location(res).pathname).toBe("/login");
    expect(location(res).searchParams.get("error")).toBe("link_invalid");
    expect(location(res).origin).toBe("https://app.tenderos.example");
  });

  it.each([
    ["no hash", "type=email"],
    ["no type", `token_hash=${TOKEN}`],
    ["an unsupported type", `token_hash=${TOKEN}&type=magiclink`],
    ["an invite type", `token_hash=${TOKEN}&type=invite`],
    ["an empty hash", "token_hash=&type=email"],
    ["an oversized hash", `token_hash=${"a".repeat(600)}&type=email`],
  ])("does not call Supabase for %s", async (_name, query) => {
    const res = await call(query);
    expect(h.verifyOtp).not.toHaveBeenCalled();
    expect(location(res).searchParams.get("error")).toBe("link_invalid");
  });

  it("does not echo the token into the redirect", async () => {
    const res = await call(`token_hash=${TOKEN}&type=email&next=/onboarding`);
    expect(res.headers.get("location")).not.toContain(TOKEN);
  });
});
