import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { appUrl } = await import("@/lib/env");
const { authRedirectUrl } = await import("@/lib/auth/urls");

describe("appUrl", () => {
  it("returns the origin of APP_URL without a trailing slash", () => {
    expect(appUrl({ APP_URL: "https://app.tenderos.example/" })).toBe("https://app.tenderos.example");
    expect(appUrl({ APP_URL: "https://app.tenderos.example" })).toBe("https://app.tenderos.example");
  });

  it("defaults to localhost outside production", () => {
    expect(appUrl({})).toBe("http://localhost:3000");
    expect(appUrl({ NODE_ENV: "development", APP_URL: "" })).toBe("http://localhost:3000");
  });

  it("has no default in production", () => {
    expect(() => appUrl({ NODE_ENV: "production" })).toThrow(/APP_URL is required in production/);
    expect(() => appUrl({ NODE_ENV: "production", APP_URL: "  " })).toThrow(/APP_URL is required in production/);
  });

  it("requires https in production, except for a local server", () => {
    expect(() => appUrl({ NODE_ENV: "production", APP_URL: "http://app.tenderos.example" })).toThrow(/https/);
    expect(appUrl({ NODE_ENV: "production", APP_URL: "http://127.0.0.1:3100" })).toBe("http://127.0.0.1:3100");
    expect(appUrl({ NODE_ENV: "production", APP_URL: "https://app.tenderos.example" })).toBe("https://app.tenderos.example");
  });

  it.each([
    "not a url",
    "https://app.tenderos.example/base",
    "https://app.tenderos.example/?x=1",
    "https://app.tenderos.example/#top",
    "ftp://app.tenderos.example",
  ])("rejects %s", (value) => {
    expect(() => appUrl({ APP_URL: value })).toThrow(/APP_URL/);
  });
});

describe("authRedirectUrl", () => {
  const env = { APP_URL: "https://app.tenderos.example/" };

  it("builds links from APP_URL, never from a request", () => {
    expect(authRedirectUrl("/auth/callback", {}, env)).toBe("https://app.tenderos.example/auth/callback");
  });

  it("adds a next path that passed safeRedirectPath", () => {
    expect(authRedirectUrl("/auth/callback", { next: "/reset-password" }, env)).toBe("https://app.tenderos.example/auth/callback?next=%2Freset-password");
    expect(authRedirectUrl("/auth/callback", { next: "/tenders/1?tab=documents" }, env)).toBe(
      "https://app.tenderos.example/auth/callback?next=%2Ftenders%2F1%3Ftab%3Ddocuments",
    );
  });

  it.each(["//evil.example", "https://evil.example", "/\\evil.example", "javascript:alert(1)", "/\r\nSet-Cookie: x=1"])("drops an unsafe next (%s)", (next) => {
    const url = authRedirectUrl("/auth/callback", { next }, env);
    expect(url).not.toContain("evil");
    expect(new URL(url).origin).toBe("https://app.tenderos.example");
  });

  it("refuses an absolute or protocol-relative path", () => {
    expect(() => authRedirectUrl("https://evil.example/x", {}, env)).toThrow();
    expect(() => authRedirectUrl("//evil.example", {}, env)).toThrow();
    expect(() => authRedirectUrl("auth/callback", {}, env)).toThrow();
  });
});
