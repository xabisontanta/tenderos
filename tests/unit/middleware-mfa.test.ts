import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  aal: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: h.user } }),
      mfa: { getAuthenticatorAssuranceLevel: h.aal },
    },
  }),
}));

const { updateSession } = await import("@/lib/supabase/middleware");

const call = (path: string) => updateSession(new NextRequest(`http://127.0.0.1:3000${path}`), new Headers());
const location = (res: Response) => res.headers.get("location");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:56321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key-for-tests-0123456789");
  h.user = { id: "u1" };
  h.aal.mockReset().mockResolvedValue({ data: { currentLevel: "aal1", nextLevel: "aal1", currentAuthenticationMethods: [] }, error: null });
});

describe("updateSession and the second factor", () => {
  it("sends a password-only session of someone with an authenticator to /mfa, remembering the page", async () => {
    h.aal.mockResolvedValue({ data: { currentLevel: "aal1", nextLevel: "aal2", currentAuthenticationMethods: [] }, error: null });
    const res = await call("/tenders?status=open");
    expect(res.status).toBe(307);
    const url = new URL(location(res)!);
    expect(url.pathname).toBe("/mfa");
    expect(url.searchParams.get("next")).toBe("/tenders?status=open");
  });

  it("does not remember the dashboard", async () => {
    h.aal.mockResolvedValue({ data: { currentLevel: "aal1", nextLevel: "aal2" }, error: null });
    const url = new URL(location(await call("/"))!);
    expect(url.pathname).toBe("/mfa");
    expect(url.search).toBe("");
  });

  it("lets the challenge page itself, and its form posts, through", async () => {
    h.aal.mockResolvedValue({ data: { currentLevel: "aal1", nextLevel: "aal2" }, error: null });
    for (const path of ["/mfa", "/mfa?next=%2Ftenders"]) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
      expect(location(res), path).toBeNull();
    }
  });

  it("leaves the public pages and the helper's own API alone", async () => {
    h.aal.mockResolvedValue({ data: { currentLevel: "aal1", nextLevel: "aal2" }, error: null });
    for (const path of ["/login", "/auth/confirm?token_hash=x", "/api/autofill/profile", "/terms", "/invite"]) {
      const res = await call(path);
      expect(location(res), path).toSatisfy((l: string | null) => l === null || new URL(l).pathname !== "/mfa");
    }
  });

  it("lets a session through that already passed the challenge, or that has no authenticator", async () => {
    h.aal.mockResolvedValue({ data: { currentLevel: "aal2", nextLevel: "aal2" }, error: null });
    expect((await call("/tenders")).status).toBe(200);
    h.aal.mockResolvedValue({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null });
    expect((await call("/tenders")).status).toBe(200);
  });

  it("does not turn a failed lookup into a lock-out", async () => {
    h.aal.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await call("/tenders")).status).toBe(200);
    h.aal.mockRejectedValue(new Error("network"));
    expect((await call("/tenders")).status).toBe(200);
  });

  it("still sends a signed-out visitor to sign in, without asking about authenticators", async () => {
    h.user = null;
    const res = await call("/tenders");
    expect(new URL(location(res)!).pathname).toBe("/login");
    expect(h.aal).not.toHaveBeenCalled();
  });
});
