import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  role: "admin" as string,
  rpc: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/data/context", () => ({
  requireContext: async () => ({ userId: "user-1", organisation: { id: "org-1" }, role: h.role }),
  canAdminister: (role: string) => role === "owner" || role === "admin",
}));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: async () => ({ rpc: h.rpc }) }));

const { changeTenderDelivery } = await import("@/features/tenders/actions");

const TENDER = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  h.role = "admin";
  h.rpc.mockReset().mockResolvedValue({ data: { withdrawn: true, approvals_cancelled: 1, status: "PREPARING_BID" }, error: null });
  h.revalidatePath.mockReset();
});

describe("changeTenderDelivery", () => {
  it("sends only the changed details and the reason, and says the approval was withdrawn", async () => {
    const res = await changeTenderDelivery(TENDER, { submission_destination: "new@city.gov.za" }, "  Corrected in addendum 2 ");
    expect(res).toEqual({ ok: true, data: { withdrawn: true } });
    expect(h.rpc).toHaveBeenCalledWith("change_tender_delivery", {
      p_tender_id: TENDER,
      p_changes: { submission_destination: "new@city.gov.za" },
      p_reason: "Corrected in addendum 2",
    });
    expect(h.revalidatePath).toHaveBeenCalledWith(`/tenders/${TENDER}`);
  });

  it.each(["operator", "viewer"])("is for owners and admins, not a %s", async (role) => {
    h.role = role;
    const res = await changeTenderDelivery(TENDER, { submission_destination: "x@y.gov.za" }, "A reason");
    expect(res).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("refuses what is not a delivery detail, a bad link, a missing reason or a bad id before asking the database", async () => {
    expect(await changeTenderDelivery(TENDER, { title: "x" }, "A reason")).toMatchObject({ ok: false });
    expect(await changeTenderDelivery(TENDER, { source_url: "javascript:alert(1)" }, "A reason")).toMatchObject({ ok: false });
    expect(await changeTenderDelivery(TENDER, {}, "A reason")).toMatchObject({ ok: false });
    expect(await changeTenderDelivery(TENDER, { submission_destination: "x@y.gov.za" }, "ab")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/reason/i),
    });
    expect(await changeTenderDelivery("not-a-uuid", { submission_destination: "x@y.gov.za" }, "A reason")).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("shows the database's own refusal (for example, the bid was already delivered)", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "23514", message: "This bid has already been delivered or closed" } });
    expect(await changeTenderDelivery(TENDER, { submission_destination: "x@y.gov.za" }, "A reason")).toEqual({
      ok: false,
      error: "This bid has already been delivered or closed",
    });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a change that withdrew nothing as such", async () => {
    h.rpc.mockResolvedValue({ data: { withdrawn: false, approvals_cancelled: 0, status: "DISCOVERED" }, error: null });
    expect(await changeTenderDelivery(TENDER, { source_url: "https://city.gov.za/new" }, "Link moved")).toEqual({ ok: true, data: { withdrawn: false } });
  });
});
