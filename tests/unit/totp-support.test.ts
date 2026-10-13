import { describe, expect, it } from "vitest";
import { base32Decode, totp } from "../support/totp";

// RFC 6238, appendix B: the SHA-1 secret is the ASCII string "12345678901234567890", and the test times
// and 8-digit codes are published there. Six digits are the last six of those codes.
const RFC_SECRET_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp (RFC 6238, HMAC-SHA1, 30 second step)", () => {
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("matches the published 8-digit code at %i", (seconds, expected) => {
    expect(totp(RFC_SECRET_BASE32, { at: seconds * 1000, digits: 8 })).toBe(expected);
  });

  it("gives six digits by default, the tail of the 8-digit code", () => {
    expect(totp(RFC_SECRET_BASE32, { at: 59_000 })).toBe("287082");
    expect(totp(RFC_SECRET_BASE32, { at: 1111111109 * 1000 })).toBe("081804");
  });

  it("keeps leading zeros", () => {
    expect(totp(RFC_SECRET_BASE32, { at: 1234567890 * 1000 })).toBe("005924");
  });

  it("is constant inside a 30 second step and changes at the boundary", () => {
    const start = 1_700_000_010_000 - (1_700_000_010_000 % 30_000);
    expect(totp(RFC_SECRET_BASE32, { at: start })).toBe(totp(RFC_SECRET_BASE32, { at: start + 29_999 }));
    expect(totp(RFC_SECRET_BASE32, { at: start })).not.toBe(totp(RFC_SECRET_BASE32, { at: start + 30_000 }));
  });

  it("can ask for the previous or next step, for clock skew", () => {
    const at = 1_700_000_015_000;
    expect(totp(RFC_SECRET_BASE32, { at, stepOffset: 1 })).toBe(totp(RFC_SECRET_BASE32, { at: at + 30_000 }));
    expect(totp(RFC_SECRET_BASE32, { at, stepOffset: -1 })).toBe(totp(RFC_SECRET_BASE32, { at: at - 30_000 }));
  });
});

describe("base32Decode", () => {
  it("decodes RFC 4648 text, ignoring case, spaces and padding", () => {
    expect(base32Decode("MZXW6YTBOI======").toString("utf8")).toBe("foobar");
    expect(base32Decode("mzxw 6ytb oi").toString("utf8")).toBe("foobar");
    expect(base32Decode(RFC_SECRET_BASE32).toString("ascii")).toBe("12345678901234567890");
  });

  it("refuses characters that are not in the alphabet", () => {
    expect(() => base32Decode("MZXW1")).toThrow();
  });
});
