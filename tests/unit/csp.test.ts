import { describe, expect, it } from "vitest";
import { buildCsp } from "@/lib/security/csp";

const directive = (csp: string, name: string) =>
  csp
    .split("; ")
    .find((d) => d.startsWith(`${name} `))
    ?.split(" ")
    .slice(1);

describe("buildCsp", () => {
  const csp = buildCsp("nonce123", "http://127.0.0.1:54321", false);

  it("keeps scripts on a nonce and the page out of frames", () => {
    expect(directive(csp, "script-src")).toEqual(["'self'", "'nonce-nonce123'", "'strict-dynamic'"]);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
  });

  it("allows no third party when Turnstile is not configured", () => {
    expect(csp).not.toContain("cloudflare");
    expect(directive(csp, "frame-src")).toBeUndefined();
  });

  it("allows Cloudflare Turnstile for scripts, frames and connections only when asked", () => {
    const withTurnstile = buildCsp("nonce123", "http://127.0.0.1:54321", false, { turnstile: true });
    const cf = "https://challenges.cloudflare.com";
    expect(directive(withTurnstile, "script-src")).toContain(cf);
    expect(directive(withTurnstile, "frame-src")).toEqual([cf]);
    expect(directive(withTurnstile, "connect-src")).toContain(cf);
    expect(directive(withTurnstile, "script-src")).toContain("'strict-dynamic'");
    expect(directive(withTurnstile, "default-src")).toEqual(["'self'"]);
  });
});
