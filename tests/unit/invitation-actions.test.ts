import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "22222222-2222-4222-8222-222222222222";
const INV = "44444444-4444-4444-8444-444444444444";
const TOKEN = `tinv_${"ef56".repeat(16)}`;
const EXPIRES = "2026-10-19T08:00:00.000Z";

const h = vi.hoisted(() => ({
  role: "owner" as string,
  fullName: "Sipho Dlamini" as string | null,
  rpc: vi.fn(),
  single: vi.fn(),
  send: vi.fn(),
  revalidate: vi.fn(),
  logs: [] as unknown[],
}));

vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("@/lib/data/context", () => ({
  requireContext: async () => ({
    userId: "11111111-1111-4111-8111-111111111111",
    email: "sipho@khumalo.example",
    fullName: h.fullName,
    organisation: { id: ORG, name: "Khumalo Civils", slug: "khumalo" },
    role: h.role,
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  getServerSupabase: async () => ({
    rpc: h.rpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: h.single }) }) }),
  }),
}));
vi.mock("@/lib/email/team-invitation", () => ({ sendTeamInvitation: h.send }));
vi.mock("@/lib/log", () => ({
  createLogger: () => {
    const emit = (...args: unknown[]) => void h.logs.push(args);
    return { debug: emit, info: emit, warn: emit, error: emit, child: () => ({}) };
  },
}));

const { inviteMember, resendInvitation, revokeInvitation } = await import("@/features/team/invitations");

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("APP_URL", "https://app.tenderos.example");
  h.role = "owner";
  h.fullName = "Sipho Dlamini";
  h.logs.length = 0;
  h.revalidate.mockReset();
  h.rpc.mockReset().mockResolvedValue({ data: [{ invitation_id: INV, token: TOKEN, expires_at: EXPIRES }], error: null });
  h.single.mockReset().mockResolvedValue({ data: { email: "thandi@auditors.example", role: "viewer" }, error: null });
  h.send.mockReset().mockResolvedValue({ ok: true, delivered: true, messageId: "<m>" });
});

describe("inviteMember", () => {
  it("creates the invitation, emails it from the inviter, and hands back the link once", async () => {
    const res = await inviteMember("  Thandi@Auditors.example ", "viewer");
    expect(h.rpc).toHaveBeenCalledWith("create_invitation", { p_org: ORG, p_email: "thandi@auditors.example", p_role: "viewer" });
    expect(h.send).toHaveBeenCalledWith({
      to: "thandi@auditors.example",
      inviterName: "Sipho Dlamini",
      organisationName: "Khumalo Civils",
      role: "viewer",
      token: TOKEN,
      expiresAt: EXPIRES,
    });
    expect(res).toEqual({
      ok: true,
      data: {
        id: INV,
        email: "thandi@auditors.example",
        link: `https://app.tenderos.example/invite/${TOKEN}`,
        emailed: true,
        notice: null,
        expiresAt: EXPIRES,
      },
    });
    expect(h.revalidate).toHaveBeenCalled();
  });

  it("falls back to a neutral name when the inviter has none, rather than showing their address", async () => {
    h.fullName = null;
    await inviteMember("thandi@auditors.example", "viewer");
    expect(h.send.mock.calls[0][0].inviterName).toBe("A colleague");
  });

  it("keeps the invitation and says so when the email cannot be sent, so the link can be shared by hand", async () => {
    h.send.mockResolvedValue({ ok: false, error: "The email could not be sent" });
    const res = await inviteMember("thandi@auditors.example", "operator");
    expect(res).toMatchObject({ ok: true, data: { emailed: false, link: `https://app.tenderos.example/invite/${TOKEN}` } });
    expect((res as { data: { notice: string } }).data.notice).toMatch(/could not be sent/i);
  });

  it("says when this server has no mail set up (development), and still hands back the link", async () => {
    h.send.mockResolvedValue({ ok: true, delivered: false, messageId: null });
    const res = await inviteMember("thandi@auditors.example", "viewer");
    expect(res).toMatchObject({ ok: true, data: { emailed: false } });
    expect((res as { data: { notice: string } }).data.notice).toMatch(/no email|not set up|share the link/i);
  });

  it("offers an admin only operator and viewer, an owner admin as well, and nobody owner", async () => {
    h.role = "admin";
    expect(await inviteMember("a@b.example", "admin")).toMatchObject({ ok: false });
    expect(await inviteMember("a@b.example", "owner")).toMatchObject({ ok: false });
    expect(await inviteMember("a@b.example", "operator")).toMatchObject({ ok: true });
    h.role = "owner";
    expect(await inviteMember("a@b.example", "owner")).toMatchObject({ ok: false });
    expect(await inviteMember("a@b.example", "admin")).toMatchObject({ ok: true });
    h.role = "operator";
    expect(await inviteMember("a@b.example", "viewer")).toMatchObject({ ok: false });
    expect(await inviteMember("a@b.example", "wizard")).toMatchObject({ ok: false });
  });

  it("rejects a bad address before calling the database", async () => {
    h.rpc.mockClear();
    for (const bad of ["", "nope", "a@b", `${"x".repeat(250)}@b.example`, "a b@c.example"]) {
      expect(await inviteMember(bad, "viewer"), bad).toMatchObject({ ok: false });
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("shows the database's refusal (duplicate, member, cap, limit) and sends nothing", async () => {
    h.rpc.mockResolvedValue({
      data: null,
      error: { code: "23514", message: "There is already a pending invitation for that address. Resend or revoke it instead." },
    });
    const res = await inviteMember("thandi@auditors.example", "viewer");
    expect(res).toEqual({ ok: false, error: "There is already a pending invitation for that address. Resend or revoke it instead." });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("never logs the address, the token or the link", async () => {
    await inviteMember("thandi@auditors.example", "viewer");
    h.send.mockResolvedValue({ ok: false, error: "x" });
    await inviteMember("thandi@auditors.example", "viewer");
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain("thandi@auditors.example");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("ef56");
  });
});

describe("resendInvitation", () => {
  it("rotates the token, emails the new link to the address on file, and returns it", async () => {
    const res = await resendInvitation(INV);
    expect(h.rpc).toHaveBeenCalledWith("resend_invitation", { p_id: INV });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ to: "thandi@auditors.example", role: "viewer", token: TOKEN }));
    expect(res).toMatchObject({ ok: true, data: { id: INV, emailed: true, link: `https://app.tenderos.example/invite/${TOKEN}` } });
  });

  it("refuses an id that is not one", async () => {
    expect(await resendInvitation("nope")).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("shows the database's refusal and does not email", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "Invitation not found" } });
    expect(await resendInvitation(INV)).toEqual({ ok: false, error: "Invitation not found" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("still returns the link when the invitation's address cannot be read back", async () => {
    h.single.mockResolvedValue({ data: null, error: null });
    const res = await resendInvitation(INV);
    expect(res).toMatchObject({ ok: true, data: { emailed: false } });
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("revokeInvitation", () => {
  it("revokes through the database", async () => {
    h.rpc.mockResolvedValue({ data: null, error: null });
    expect(await revokeInvitation(INV)).toEqual({ ok: true });
    expect(h.rpc).toHaveBeenCalledWith("revoke_invitation", { p_id: INV });
  });

  it("refuses an id that is not one, and shows a refusal", async () => {
    expect(await revokeInvitation("x")).toMatchObject({ ok: false });
    h.rpc.mockResolvedValue({ data: null, error: { code: "23514", message: "That invitation was already used or revoked" } });
    expect(await revokeInvitation(INV)).toEqual({ ok: false, error: "That invitation was already used or revoked" });
  });
});
