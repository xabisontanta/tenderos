import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({ aal: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  getServerSupabase: async () => ({ auth: { mfa: { getAuthenticatorAssuranceLevel: h.aal } } }),
}));

const { requireAal2 } = await import("@/lib/auth/require-aal2");
const { AAL2_MESSAGE, isAal2Message } = await import("@/lib/auth/mfa-errors");
const { toUserError } = await import("@/lib/actions");

const REQUIRED = { settings: { require_mfa: true } };

beforeEach(() => {
  h.aal.mockReset().mockResolvedValue({ data: { currentLevel: "aal2", nextLevel: "aal2", currentAuthenticationMethods: [] }, error: null });
});

describe("requireAal2 (the check for paths that run as the service role and skip the database's)", () => {
  it("lets everything through when the organisation does not require MFA, without asking Supabase", async () => {
    expect(await requireAal2({ settings: { require_mfa: false } })).toBeNull();
    expect(h.aal).not.toHaveBeenCalled();
  });

  it("lets a session through that has passed the authenticator challenge", async () => {
    expect(await requireAal2(REQUIRED)).toBeNull();
  });

  it("refuses a session that has only a password, in words that point at the challenge", async () => {
    h.aal.mockResolvedValue({ data: { currentLevel: "aal1", nextLevel: "aal2" }, error: null });
    expect(await requireAal2(REQUIRED)).toBe(AAL2_MESSAGE);
    h.aal.mockResolvedValue({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null });
    expect(await requireAal2(REQUIRED)).toBe(AAL2_MESSAGE);
  });

  it("fails closed when the level cannot be read", async () => {
    h.aal.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await requireAal2(REQUIRED)).toBe(AAL2_MESSAGE);
    h.aal.mockResolvedValue({ data: { currentLevel: null, nextLevel: null }, error: null });
    expect(await requireAal2(REQUIRED)).toBe(AAL2_MESSAGE);
    h.aal.mockRejectedValue(new Error("network"));
    expect(await requireAal2(REQUIRED)).toBe(AAL2_MESSAGE);
  });

  it("treats a context with no settings as not requiring it, so callers that never load them are unchanged", async () => {
    expect(await requireAal2({} as never)).toBeNull();
  });
});

describe("the message", () => {
  it("is what the database raises (P0403) and what the screens recognise", () => {
    expect(AAL2_MESSAGE).toMatch(/^Verify with your authenticator/);
    expect(isAal2Message(AAL2_MESSAGE)).toBe(true);
    expect(isAal2Message("Verify with your authenticator, then try again.")).toBe(true);
    expect(isAal2Message("Could not save")).toBe(false);
    expect(isAal2Message(undefined)).toBe(false);
  });

  it("is what toUserError shows for the database's P0403, whatever text came with it", () => {
    expect(toUserError({ code: "P0403", message: "anything the database said" } as never)).toBe(AAL2_MESSAGE);
  });
});
