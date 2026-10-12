import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const U = "11111111-1111-4111-8111-111111111111";
const F1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const F2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHALLENGE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const QR = "data:image/svg+xml;utf-8,<svg xmlns='http://www.w3.org/2000/svg'></svg>";

const h = vi.hoisted(() => ({
  user: { id: "11111111-1111-4111-8111-111111111111" } as { id: string } | null,
  rpc: vi.fn(),
  enroll: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
  unenroll: vi.fn(),
  listFactors: vi.fn(),
  revalidate: vi.fn(),
  logs: [] as unknown[],
}));

vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/data/context", () => ({
  requireContext: async () => ({ userId: "11111111-1111-4111-8111-111111111111", organisation: { id: "o1" }, settings: { require_mfa: false } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  getServerSupabase: async () => ({
    rpc: h.rpc,
    auth: {
      getUser: async () => ({ data: { user: h.user } }),
      mfa: { enroll: h.enroll, challenge: h.challenge, verify: h.verify, unenroll: h.unenroll, listFactors: h.listFactors },
    },
  }),
}));
vi.mock("@/lib/log", () => ({
  createLogger: () => {
    const emit = (...args: unknown[]) => void h.logs.push(args);
    return { debug: emit, info: emit, warn: emit, error: emit, child: () => ({}) };
  },
}));

const { verifyChallenge, startEnrolment, confirmEnrolment, cancelEnrolment, removeFactor } = await import("@/features/security/actions");

const form = (values: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
};
const factor = (id: string, status: "verified" | "unverified", type = "totp") => ({ id, status, factor_type: type, friendly_name: id.slice(0, 4) });

beforeEach(() => {
  h.user = { id: U };
  h.logs.length = 0;
  h.revalidate.mockReset();
  h.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  h.enroll
    .mockReset()
    .mockResolvedValue({
      data: { id: F1, type: "totp", friendly_name: "Authenticator app", totp: { qr_code: QR, secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/x" } },
      error: null,
    });
  h.challenge.mockReset().mockResolvedValue({ data: { id: CHALLENGE, type: "totp", expires_at: 1 }, error: null });
  h.verify.mockReset().mockResolvedValue({ data: { access_token: "t" }, error: null });
  h.unenroll.mockReset().mockResolvedValue({ data: { id: F1 }, error: null });
  h.listFactors.mockReset().mockResolvedValue({ data: { all: [], totp: [], phone: [], webauthn: [], recovery_code: [] }, error: null });
});

describe("verifyChallenge (the /mfa page)", () => {
  it("counts the attempt, challenges the factor, verifies the code and carries on to the page asked for", async () => {
    await expect(verifyChallenge({}, form({ factorId: F1, code: "123 456", next: "/tenders" }))).rejects.toThrow("NEXT_REDIRECT:/tenders");
    expect(h.rpc).toHaveBeenCalledWith("hit_rate_limit", { p_action: "mfa.verify", p_max: 10, p_window_seconds: 900 });
    expect(h.challenge).toHaveBeenCalledWith({ factorId: F1 });
    expect(h.verify).toHaveBeenCalledWith({ factorId: F1, challengeId: CHALLENGE, code: "123456" });
  });

  it("never follows an unsafe next", async () => {
    await expect(verifyChallenge({}, form({ factorId: F1, code: "123456", next: "//evil.example" }))).rejects.toThrow("NEXT_REDIRECT:/");
    await expect(verifyChallenge({}, form({ factorId: F1, code: "123456", next: "https://evil.example" }))).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("asks again, with the code field marked, for a code that is not six digits, without touching the server", async () => {
    for (const code of ["", "12345", "abcdef", "1234567"]) {
      const res = await verifyChallenge({}, form({ factorId: F1, code }));
      expect(res.fieldErrors?.code, code).toBeTruthy();
    }
    expect(h.challenge).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("says a wrong code did not work, in words, and keeps the person on the page", async () => {
    h.verify.mockResolvedValue({ data: null, error: { code: "mfa_verification_failed", message: "Invalid TOTP code entered", status: 400 } });
    const res = await verifyChallenge({}, form({ factorId: F1, code: "000000", next: "/tenders" }));
    expect(res.error).toMatch(/code did not work/i);
    expect(res.error).not.toMatch(/invalid totp/i);
  });

  it("stops at the attempt limit before asking Supabase anything", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "P0429", message: "Too many requests; please wait and try again" } });
    const res = await verifyChallenge({}, form({ factorId: F1, code: "123456" }));
    expect(res.error).toMatch(/too many/i);
    expect(h.challenge).not.toHaveBeenCalled();
  });

  it("sends someone who is not signed in to sign in", async () => {
    h.user = null;
    await expect(verifyChallenge({}, form({ factorId: F1, code: "123456" }))).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("refuses a factor id that is not one", async () => {
    const res = await verifyChallenge({}, form({ factorId: "nope", code: "123456" }));
    expect(res.error).toBeTruthy();
    expect(h.challenge).not.toHaveBeenCalled();
  });

  it("never logs the code", async () => {
    h.verify.mockResolvedValue({ data: null, error: { code: "mfa_verification_failed", message: "Invalid TOTP code entered", status: 400 } });
    await verifyChallenge({}, form({ factorId: F1, code: "424242" }));
    expect(JSON.stringify(h.logs)).not.toContain("424242");
  });
});

describe("startEnrolment (Settings, Security)", () => {
  it("enrols a TOTP factor named for TenderOS and returns what the page needs to show", async () => {
    const res = await startEnrolment("My phone");
    expect(h.enroll).toHaveBeenCalledWith({ factorType: "totp", friendlyName: "My phone", issuer: "TenderOS" });
    expect(res).toEqual({ ok: true, data: { factorId: F1, qrCode: QR, secret: "JBSWY3DPEHPK3PXP" } });
  });

  it("is limited to ten starts an hour", async () => {
    await startEnrolment("My phone");
    expect(h.rpc).toHaveBeenCalledWith("hit_rate_limit", { p_action: "mfa.enroll", p_max: 10, p_window_seconds: 3600 });
  });

  it("clears out an enrolment that was started and never finished, so its name is free again", async () => {
    h.listFactors.mockResolvedValue({
      data: { all: [factor(F2, "unverified"), factor("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "verified")], totp: [] },
      error: null,
    });
    await startEnrolment("Authenticator app");
    expect(h.unenroll).toHaveBeenCalledTimes(1);
    expect(h.unenroll).toHaveBeenCalledWith({ factorId: F2 });
  });

  it("falls back to a plain name and refuses a name that is too long", async () => {
    await startEnrolment("");
    expect(h.enroll.mock.calls[0][0].friendlyName).toBe("Authenticator app");
    expect(await startEnrolment("x".repeat(61))).toMatchObject({ ok: false });
  });

  it("explains a name already in use, a full list, and an authenticator the server does not allow", async () => {
    h.enroll.mockResolvedValue({ data: null, error: { code: "mfa_factor_name_conflict", message: "x", status: 422 } });
    expect(await startEnrolment("Phone")).toMatchObject({ ok: false, error: expect.stringMatching(/already have.*that name/i) });
    h.enroll.mockResolvedValue({ data: null, error: { code: "too_many_enrolled_mfa_factors", message: "x", status: 422 } });
    expect(await startEnrolment("Phone")).toMatchObject({ ok: false, error: expect.stringMatching(/limit/i) });
    h.enroll.mockResolvedValue({ data: null, error: { code: "mfa_totp_enroll_not_enabled", message: "x", status: 422 } });
    expect(await startEnrolment("Phone")).toMatchObject({ ok: false, error: expect.stringMatching(/not switched on/i) });
  });

  it("does not hand back a QR code that is not the SVG data URL it should be", async () => {
    h.enroll.mockResolvedValue({
      data: { id: F1, type: "totp", totp: { qr_code: "https://evil.example/qr.svg", secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://x" } },
      error: null,
    });
    expect(await startEnrolment("Phone")).toMatchObject({ ok: false });
  });

  it("never logs the secret, the QR code or the URI", async () => {
    await startEnrolment("Phone");
    h.enroll.mockResolvedValue({ data: null, error: { code: "unexpected_failure", message: "JBSWY3DPEHPK3PXP", status: 500 } });
    await startEnrolment("Phone");
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain("JBSWY3DPEHPK3PXP");
    expect(text).not.toContain("otpauth");
    expect(text).not.toContain("svg");
  });
});

describe("confirmEnrolment", () => {
  it("verifies the first code, which turns the factor on and refreshes the page", async () => {
    expect(await confirmEnrolment(F1, "654 321")).toEqual({ ok: true });
    expect(h.challenge).toHaveBeenCalledWith({ factorId: F1 });
    expect(h.verify).toHaveBeenCalledWith({ factorId: F1, challengeId: CHALLENGE, code: "654321" });
    expect(h.revalidate).toHaveBeenCalled();
  });

  it("counts the attempt, rejects a malformed code without calling Supabase, and explains a wrong one", async () => {
    expect(await confirmEnrolment(F1, "12")).toMatchObject({ ok: false });
    expect(h.challenge).not.toHaveBeenCalled();
    h.verify.mockResolvedValue({ data: null, error: { code: "mfa_verification_failed", message: "Invalid TOTP code entered", status: 400 } });
    expect(await confirmEnrolment(F1, "000000")).toMatchObject({ ok: false, error: expect.stringMatching(/code did not work/i) });
    expect(h.rpc).toHaveBeenCalledWith("hit_rate_limit", { p_action: "mfa.verify", p_max: 10, p_window_seconds: 900 });
  });
});

describe("cancelEnrolment and removeFactor", () => {
  it("cancels a factor that was never verified", async () => {
    h.listFactors.mockResolvedValue({ data: { all: [factor(F1, "unverified")], totp: [] }, error: null });
    expect(await cancelEnrolment(F1)).toEqual({ ok: true });
    expect(h.unenroll).toHaveBeenCalledWith({ factorId: F1 });
  });

  it("will not use 'cancel' to remove a factor that is switched on", async () => {
    h.listFactors.mockResolvedValue({ data: { all: [factor(F1, "verified")], totp: [factor(F1, "verified")] }, error: null });
    expect(await cancelEnrolment(F1)).toMatchObject({ ok: false });
    expect(h.unenroll).not.toHaveBeenCalled();
  });

  it("removes a verified factor, and tells the person to verify first when Supabase wants aal2", async () => {
    expect(await removeFactor(F1)).toEqual({ ok: true });
    expect(h.unenroll).toHaveBeenCalledWith({ factorId: F1 });
    h.unenroll.mockResolvedValue({ data: null, error: { code: "insufficient_aal", message: "AAL2 required to enroll a new factor", status: 401 } });
    expect(await removeFactor(F1)).toMatchObject({ ok: false, error: expect.stringMatching(/verify with your authenticator/i) });
  });

  it("refuses ids that are not ids", async () => {
    expect(await removeFactor("x")).toMatchObject({ ok: false });
    expect(await cancelEnrolment("x")).toMatchObject({ ok: false });
    expect(h.unenroll).not.toHaveBeenCalled();
  });
});
