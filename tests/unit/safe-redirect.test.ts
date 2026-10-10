import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "@/lib/safe-redirect";

describe("safeRedirectPath", () => {
  it.each([
    ["/tenders/123?tab=submission", "/tenders/123?tab=submission"],
    ["/reset-password", "/reset-password"],
    ["/", "/"],
  ])("keeps the same-site path %s", (input, out) => expect(safeRedirectPath(input)).toBe(out));

  it.each(["//evil.com", "/\\evil.com", "/\\/evil.com", "https://evil.com", "javascript:alert(1)", "/%0d%0aLocation:evil", "/\tevil", "", null, 42])(
    "falls back to / for %s",
    (input) => {
      const out = safeRedirectPath(input);
      expect(out === "/" || (out.startsWith("/") && !out.startsWith("//"))).toBe(true);
      expect(out).not.toMatch(/evil\.com|javascript/);
    },
  );
});
