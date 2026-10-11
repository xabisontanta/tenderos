import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({ exchangeCodeForSession: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: async () => ({ auth: { exchangeCodeForSession: h.exchangeCodeForSession } }) }));

const { GET } = await import("@/app/auth/callback/route");

// The request URL is what the server believes its own origin is; behind a proxy
// that can be an internal address, so redirects must come from APP_URL.
const call = (path: string) => GET(new NextRequest(`http://internal.local:3000${path}`));

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("APP_URL", "https://app.tenderos.example");
  h.exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
});

describe("GET /auth/callback", () => {
  it("redirects to APP_URL after exchanging the code", async () => {
    const res = await call("/auth/callback?code=abc&next=/reset-password");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.tenderos.example/reset-password");
    expect(h.exchangeCodeForSession).toHaveBeenCalledWith("abc");
  });

  it("ignores an unsafe next and falls back to /", async () => {
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
      const res = await call(`/auth/callback?code=abc&next=${encodeURIComponent(next)}`);
      expect(res.headers.get("location")).toBe("https://app.tenderos.example/");
    }
  });

  it("sends a failed exchange back to sign-in on APP_URL", async () => {
    h.exchangeCodeForSession.mockResolvedValue({ error: { message: "bad code" } });
    const res = await call("/auth/callback?code=abc");
    expect(new URL(res.headers.get("location")!).origin).toBe("https://app.tenderos.example");
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("sends a request with no code to sign-in", async () => {
    const res = await call("/auth/callback");
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(h.exchangeCodeForSession).not.toHaveBeenCalled();
  });
});
