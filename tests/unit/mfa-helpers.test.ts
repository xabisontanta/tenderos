import { describe, expect, it } from "vitest";
import { MFA_PATH, cleanTotpCode, isQrDataUrl, mfaRedirectPath, needsSecondFactor } from "@/lib/auth/mfa";

describe("needsSecondFactor", () => {
  it("is true only for a session at aal1 whose user could reach aal2", () => {
    expect(needsSecondFactor({ currentLevel: "aal1", nextLevel: "aal2" })).toBe(true);
    expect(needsSecondFactor({ currentLevel: "aal2", nextLevel: "aal2" })).toBe(false);
    expect(needsSecondFactor({ currentLevel: "aal1", nextLevel: "aal1" })).toBe(false);
    expect(needsSecondFactor({ currentLevel: null, nextLevel: null })).toBe(false);
    expect(needsSecondFactor(null)).toBe(false);
    expect(needsSecondFactor(undefined)).toBe(false);
  });
});

describe("mfaRedirectPath", () => {
  it("sends the visitor to /mfa and remembers where they were going", () => {
    expect(MFA_PATH).toBe("/mfa");
    expect(mfaRedirectPath("/tenders?status=open")).toBe("/mfa?next=%2Ftenders%3Fstatus%3Dopen");
    expect(mfaRedirectPath("/settings#security")).toBe("/mfa?next=%2Fsettings%23security");
  });

  it("does not bother remembering the dashboard", () => {
    expect(mfaRedirectPath("/")).toBe("/mfa");
    expect(mfaRedirectPath(undefined)).toBe("/mfa");
    expect(mfaRedirectPath(null)).toBe("/mfa");
  });

  it("never remembers anything that could leave the site, or the challenge page itself", () => {
    for (const next of ["//evil.example", "https://evil.example/x", "/\\evil.example", "javascript:alert(1)", "/mfa", "/mfa?next=/x"]) {
      expect(mfaRedirectPath(next), next).toBe("/mfa");
    }
  });
});

describe("cleanTotpCode", () => {
  it("keeps six digits and drops the spaces and dashes people paste", () => {
    expect(cleanTotpCode("123456")).toBe("123456");
    expect(cleanTotpCode(" 123 456 ")).toBe("123456");
    expect(cleanTotpCode("123-456")).toBe("123456");
  });

  it("returns null for anything else", () => {
    for (const bad of ["", "12345", "1234567", "12345a", "abcdef", null, undefined, 123456, "１２３４５６"]) {
      expect(cleanTotpCode(bad), String(bad)).toBeNull();
    }
  });
});

describe("isQrDataUrl", () => {
  it("accepts only the SVG data URL the Auth server's QR code comes as", () => {
    expect(isQrDataUrl("data:image/svg+xml;utf-8,<svg xmlns='http://www.w3.org/2000/svg'></svg>")).toBe(true);
    expect(isQrDataUrl("data:image/svg+xml;utf-8,%3Csvg%3E%3C/svg%3E")).toBe(true);
    for (const bad of ["https://evil.example/qr.svg", "data:text/html,<script>alert(1)</script>", "javascript:alert(1)", "", "data:image/png;base64,AAAA"]) {
      expect(isQrDataUrl(bad), bad).toBe(false);
    }
  });
});
