import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("@/lib/data/context", () => ({
  requireContext: async () => ({ userId: "11111111-1111-4111-8111-111111111111", organisation: { id: "22222222-2222-4222-8222-222222222222" } }),
}));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: async () => ({ rpc: h.rpc }) }));

const { changeMemberRole, removeMember } = await import("@/features/team/actions");

const ORG = "22222222-2222-4222-8222-222222222222";
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  h.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  h.revalidate.mockReset();
});

describe("changeMemberRole", () => {
  it("asks the database to change the role of a member of the caller's organisation", async () => {
    expect(await changeMemberRole(OTHER, "operator")).toEqual({ ok: true });
    expect(h.rpc).toHaveBeenCalledWith("change_member_role", { p_org: ORG, p_user: OTHER, p_role: "operator" });
    expect(h.revalidate).toHaveBeenCalled();
  });

  it("refuses an id or role that is not one, without calling the database", async () => {
    expect(await changeMemberRole("not-an-id", "operator")).toMatchObject({ ok: false });
    expect(await changeMemberRole(OTHER, "superuser")).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("shows the database's own refusal, which is written for people", async () => {
    h.rpc.mockResolvedValue({
      data: null,
      error: { code: "23514", message: "An organisation must keep at least one owner. Make someone else an owner first." },
    });
    expect(await changeMemberRole(ME, "admin")).toEqual({
      ok: false,
      error: "An organisation must keep at least one owner. Make someone else an owner first.",
    });
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  it("hides anything else the database says", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: 'relation "x" does not exist' } });
    expect(await changeMemberRole(OTHER, "viewer")).toEqual({ ok: false, error: "Could not change the role" });
  });
});

describe("removeMember", () => {
  it("removes a member and says whether it was the caller who left", async () => {
    expect(await removeMember(OTHER)).toEqual({ ok: true, data: { left: false } });
    expect(h.rpc).toHaveBeenCalledWith("remove_member", { p_org: ORG, p_user: OTHER });
    expect(await removeMember(ME)).toEqual({ ok: true, data: { left: true } });
  });

  it("refuses an id that is not one", async () => {
    expect(await removeMember("x")).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("shows the database's refusal", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "Only an owner can remove an owner" } });
    expect(await removeMember(OTHER)).toEqual({ ok: false, error: "Only an owner can remove an owner" });
  });
});
