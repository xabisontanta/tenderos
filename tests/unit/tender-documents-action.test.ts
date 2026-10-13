import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({ role: "operator" as string, rpc: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/data/context", () => ({
  requireContext: async () => ({ userId: "user-1", organisation: { id: "org-1" }, role: h.role }),
  canAdminister: (role: string) => role === "owner" || role === "admin",
  canOperate: (role: string) => role === "owner" || role === "admin" || role === "operator",
}));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: async () => ({ rpc: h.rpc }) }));

const { fetchTenderDocuments } = await import("@/features/tenders/actions");

const TENDER = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  h.role = "operator";
  h.rpc.mockReset().mockResolvedValue({ data: 2, error: null });
});

describe("fetchTenderDocuments", () => {
  it("asks the database to fetch a tender's documents and says how many are waiting", async () => {
    expect(await fetchTenderDocuments(TENDER)).toEqual({ ok: true, data: { waiting: 2 } });
    expect(h.rpc).toHaveBeenCalledWith("fetch_tender_documents", { p_tender_id: TENDER });
  });

  it("can retry one document", async () => {
    await fetchTenderDocuments(TENDER, DOC);
    expect(h.rpc).toHaveBeenCalledWith("fetch_tender_documents", { p_tender_id: TENDER, p_document_id: DOC });
  });

  it.each([
    ["not a uuid", undefined],
    [TENDER, "nope"],
    ["", undefined],
  ])("refuses malformed ids (%s, %s) before the database", async (tender, doc) => {
    expect(await fetchTenderDocuments(tender, doc)).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("is for people who can operate, not viewers", async () => {
    h.role = "viewer";
    expect(await fetchTenderDocuments(TENDER)).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("shows the database's own message for a rule it enforces, and the authenticator message for aal2", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "23514", message: "Simulated tenders have no documents to fetch" } });
    expect(await fetchTenderDocuments(TENDER)).toEqual({ ok: false, error: "Simulated tenders have no documents to fetch" });
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0403", message: "Verify with your authenticator to do this." } });
    expect(await fetchTenderDocuments(TENDER)).toMatchObject({ ok: false, error: expect.stringMatching(/authenticator/i) });
  });

  it("does not leak internals", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: 'relation "x" does not exist' } });
    expect(await fetchTenderDocuments(TENDER)).toEqual({ ok: false, error: "Could not fetch the documents" });
  });
});
