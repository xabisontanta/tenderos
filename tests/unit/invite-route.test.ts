import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { GET } = await import("@/app/(auth)/invite/[token]/route");
const { INVITE_COOKIE, INVITE_COOKIE_MAX_AGE, inviteCookieOptions } = await import("@/lib/team/invite-cookie");
const { INVITE_TOKEN, inviteUrl } = await import("@/lib/team/invite-link");

const TOKEN = `tinv_${"ab12".repeat(16)}`;
const call = (token: string) => GET(new NextRequest(`http://internal.local:3000/invite/${token}`), { params: Promise.resolve({ token }) });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("APP_URL", "https://app.tenderos.example");
});

describe("the invitation token", () => {
  it("is tinv_ and 64 lower-case hex digits, nothing else", () => {
    expect(INVITE_TOKEN.test(TOKEN)).toBe(true);
    for (const bad of ["", "tinv_", `tinv_${"A".repeat(64)}`, `tinv_${"a".repeat(63)}`, `tinv_${"a".repeat(65)}`, `x${TOKEN}`, `${TOKEN}\n`, `${TOKEN}/..`]) {
      expect(INVITE_TOKEN.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("goes into the link from APP_URL, never from a request", () => {
    expect(inviteUrl(TOKEN)).toBe(`https://app.tenderos.example/invite/${TOKEN}`);
    expect(() => inviteUrl("nope")).toThrow();
  });
});

describe("GET /invite/[token]", () => {
  it("keeps the token in an httpOnly, SameSite=Lax cookie and sends the visitor to a page without it", async () => {
    const res = await call(TOKEN);
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://app.tenderos.example");
    expect(location.pathname).toBe("/invite");
    expect(location.href).not.toContain(TOKEN);
    expect(location.search).toBe("");

    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`${INVITE_COOKIE}=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).toMatch(new RegExp(`Max-Age=${INVITE_COOKIE_MAX_AGE}`, "i"));
    expect(cookie).toMatch(/Secure/i);
  });

  it("is short-lived", () => {
    expect(INVITE_COOKIE_MAX_AGE).toBeLessThanOrEqual(3 * 60 * 60);
    expect(INVITE_COOKIE_MAX_AGE).toBeGreaterThanOrEqual(30 * 60);
  });

  it("is not cached and does not leak the link through the Referer header", async () => {
    const res = await call(TOKEN);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("does not echo the token anywhere in the response", async () => {
    const res = await call(TOKEN);
    expect(await res.text()).not.toContain(TOKEN);
    // The cookie is the one place it goes (x-middleware-set-cookie is Next's internal copy of it, stripped before sending).
    const others = [...res.headers.entries()].filter(([name]) => name !== "set-cookie" && name !== "x-middleware-set-cookie");
    expect(others.join("\n")).not.toContain(TOKEN);
  });

  it("sets no cookie for something that is not a token, and still lands on the page that explains", async () => {
    for (const bad of ["garbage", `tinv_${"z".repeat(64)}`, "tinv_short"]) {
      const res = await call(bad);
      expect(res.headers.get("set-cookie"), bad).toBeNull();
      expect(new URL(res.headers.get("location")!).pathname).toBe("/invite");
    }
  });

  it("redirects to APP_URL whatever Host the request names", async () => {
    const res = await GET(new NextRequest(`http://evil.example/invite/${TOKEN}`, { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } }), {
      params: Promise.resolve({ token: TOKEN }),
    });
    expect(new URL(res.headers.get("location")!).origin).toBe("https://app.tenderos.example");
  });

  it("marks the cookie Secure whenever the app is served over https, and not over local http", () => {
    expect(inviteCookieOptions("https://app.tenderos.example").secure).toBe(true);
    expect(inviteCookieOptions("http://127.0.0.1:3100").secure).toBe(false);
    expect(inviteCookieOptions("https://app.tenderos.example")).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: INVITE_COOKIE_MAX_AGE });
  });
});
