import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ getAdminSupabase: () => ({ rpc: h.rpc }) }));

const { previewInvitation } = await import("@/lib/team/invite-preview");

const TOKEN = `tinv_${"9a8b".repeat(16)}`;

beforeEach(() => {
  h.rpc.mockReset();
});

describe("previewInvitation", () => {
  it("describes a live invitation for the invite page", async () => {
    h.rpc.mockResolvedValue({
      data: [
        {
          invitation_id: "i1",
          organisation_id: "o1",
          organisation_name: "Khumalo Civils",
          role: "viewer",
          email: "thandi@auditors.example",
          expires_at: "2026-10-19T08:00:00Z",
        },
      ],
      error: null,
    });
    expect(await previewInvitation(TOKEN)).toEqual({
      status: "ok",
      invitationId: "i1",
      organisationId: "o1",
      organisationName: "Khumalo Civils",
      role: "viewer",
      email: "thandi@auditors.example",
      expiresAt: "2026-10-19T08:00:00Z",
    });
    expect(h.rpc).toHaveBeenCalledWith("invitation_preview", { p_token: TOKEN });
  });

  it("reports an expired, revoked, used or unknown token as simply invalid", async () => {
    h.rpc.mockResolvedValue({ data: [], error: null });
    expect(await previewInvitation(TOKEN)).toEqual({ status: "invalid" });
  });

  it("does not call the database for something that is not a token", async () => {
    expect(await previewInvitation("garbage")).toEqual({ status: "invalid" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("tells a failed lookup apart from an invalid invitation, so the page does not claim the link is dead", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "connection reset" } });
    expect(await previewInvitation(TOKEN)).toEqual({ status: "error" });
  });
});
