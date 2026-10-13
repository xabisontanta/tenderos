import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({ role: "operator" as string, rpc: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/context", () => ({
  requireContext: async () => ({ userId: "user-1", organisation: { id: "org-1" }, role: h.role }),
  canOperate: (role: string) => role === "owner" || role === "admin" || role === "operator",
}));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: async () => ({ rpc: h.rpc }) }));

const { addPricingLine, removePricingLine, saveProposalSection, savePricingLine, setPricingConfirmed, setSectionReviewed } =
  await import("@/features/bid/actions");

const TENDER = "11111111-1111-4111-8111-111111111111";
const LINE = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  h.role = "operator";
  h.rpc.mockReset().mockResolvedValue({ data: 2, error: null });
});

describe("saveProposalSection", () => {
  it("sends the text and the version the person was looking at", async () => {
    expect(await saveProposalSection(TENDER, "methodology", "Our method.", 1)).toEqual({ ok: true, data: { version: 2 } });
    expect(h.rpc).toHaveBeenCalledWith("save_proposal_section", { p_tender_id: TENDER, p_key: "methodology", p_content: "Our method.", p_expected_version: 1 });
  });

  it.each([
    ["a bad tender", "nope", "methodology", "x", 1],
    ["a bad section key", TENDER, "Not A Key!", "x", 1],
    ["a bad version", TENDER, "methodology", "x", 0],
    ["text over the limit", TENDER, "methodology", "x".repeat(20001), 1],
  ])("refuses %s before the database", async (_label, tender, key, text, version) => {
    expect(await saveProposalSection(tender, key, text, version)).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("is for people who can operate", async () => {
    h.role = "viewer";
    expect(await saveProposalSection(TENDER, "methodology", "x", 1)).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("shows the database's own words when someone else changed the section", async () => {
    h.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "This section was changed by someone else. Reload the page to see their version." },
    });
    expect(await saveProposalSection(TENDER, "methodology", "x", 1)).toEqual({
      ok: false,
      error: "This section was changed by someone else. Reload the page to see their version.",
    });
  });

  it("asks for the authenticator when the database does", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "P0403", message: "Verify" } });
    expect(await saveProposalSection(TENDER, "methodology", "x", 1)).toMatchObject({ ok: false, error: expect.stringMatching(/authenticator/i) });
  });

  it("does not leak internals", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: 'relation "bid_proposal_sections" does not exist' } });
    expect(await saveProposalSection(TENDER, "methodology", "x", 1)).toEqual({ ok: false, error: "Could not save the section" });
  });
});

describe("setSectionReviewed", () => {
  it("marks a section reviewed or takes the review back", async () => {
    expect(await setSectionReviewed(TENDER, "methodology", true, 3)).toEqual({ ok: true, data: { version: 2 } });
    expect(h.rpc).toHaveBeenCalledWith("set_proposal_section_review", { p_tender_id: TENDER, p_key: "methodology", p_reviewed: true, p_expected_version: 3 });
    await setSectionReviewed(TENDER, "methodology", false, 4);
    expect(h.rpc).toHaveBeenLastCalledWith("set_proposal_section_review", {
      p_tender_id: TENDER,
      p_key: "methodology",
      p_reviewed: false,
      p_expected_version: 4,
    });
  });

  it("refuses a viewer", async () => {
    h.role = "viewer";
    expect(await setSectionReviewed(TENDER, "methodology", true, 1)).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("savePricingLine", () => {
  const input = { unitPrice: "1 234,50", quantity: null, supplierRef: "Q-77", expectedVersion: 1 };

  it("turns what the person typed into whole cents before it leaves the server", async () => {
    expect(await savePricingLine(LINE, input)).toEqual({ ok: true, data: { version: 2 } });
    expect(h.rpc).toHaveBeenCalledWith("save_pricing_line", {
      p_line_id: LINE,
      p_unit_price_cents: 123450,
      p_quantity: null,
      p_supplier_ref: "Q-77",
      p_expected_version: 1,
    });
  });

  it("sends a quantity as a number, and an empty price as no price", async () => {
    await savePricingLine(LINE, { unitPrice: "", quantity: "12,5", supplierRef: "", expectedVersion: 3 });
    expect(h.rpc).toHaveBeenCalledWith("save_pricing_line", {
      p_line_id: LINE,
      p_unit_price_cents: null,
      p_quantity: 12.5,
      p_supplier_ref: "",
      p_expected_version: 3,
    });
  });

  it.each([
    ["a price with letters", { unitPrice: "abc" }],
    ["a negative price", { unitPrice: "-5" }],
    ["a price with three decimals", { unitPrice: "1.234" }],
    ["a price over the cap", { unitPrice: "10000000001" }],
    ["a quantity of zero", { quantity: "0" }],
    ["a quantity with letters", { quantity: "many" }],
    ["a supplier reference over 120 characters", { supplierRef: "x".repeat(121) }],
    ["a bad version", { expectedVersion: -1 }],
  ])("refuses %s without calling the database, and says what is wrong", async (_label, over) => {
    const res = await savePricingLine(LINE, { ...input, ...over });
    expect(res).toMatchObject({ ok: false });
    expect(typeof (res as { error: string }).error).toBe("string");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("refuses a bad line id and a viewer", async () => {
    expect(await savePricingLine("nope", input)).toMatchObject({ ok: false });
    h.role = "viewer";
    expect(await savePricingLine(LINE, input)).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("shows the database's words for a quantity the tender prints", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "23514", message: "The quantity is printed in the tender and cannot be changed" } });
    expect(await savePricingLine(LINE, { ...input, quantity: "3" })).toEqual({
      ok: false,
      error: "The quantity is printed in the tender and cannot be changed",
    });
  });
});

describe("addPricingLine, removePricingLine and setPricingConfirmed", () => {
  it("adds a line with an optional quantity", async () => {
    h.rpc.mockResolvedValue({ data: LINE, error: null });
    expect(await addPricingLine(TENDER, { description: " Site establishment ", unit: "sum", quantity: "2" })).toEqual({ ok: true, data: { id: LINE } });
    expect(h.rpc).toHaveBeenCalledWith("add_pricing_line", { p_tender_id: TENDER, p_description: "Site establishment", p_unit: "sum", p_quantity: 2 });
    await addPricingLine(TENDER, { description: "Another", unit: "", quantity: "" });
    expect(h.rpc).toHaveBeenLastCalledWith("add_pricing_line", { p_tender_id: TENDER, p_description: "Another", p_unit: "", p_quantity: null });
  });

  it("refuses a line with a short description or a bad quantity", async () => {
    expect(await addPricingLine(TENDER, { description: "ab", unit: "", quantity: "" })).toMatchObject({ ok: false });
    expect(await addPricingLine(TENDER, { description: "A line", unit: "", quantity: "-1" })).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("removes a line and confirms or takes back the schedule", async () => {
    expect(await removePricingLine(LINE)).toEqual({ ok: true });
    expect(h.rpc).toHaveBeenCalledWith("remove_pricing_line", { p_line_id: LINE });
    expect(await setPricingConfirmed(TENDER, true)).toEqual({ ok: true });
    expect(h.rpc).toHaveBeenLastCalledWith("set_pricing_confirmed", { p_tender_id: TENDER, p_confirmed: true });
  });

  it("are for people who can operate", async () => {
    h.role = "viewer";
    expect(await addPricingLine(TENDER, { description: "A line", unit: "", quantity: "" })).toMatchObject({ ok: false });
    expect(await removePricingLine(LINE)).toMatchObject({ ok: false });
    expect(await setPricingConfirmed(TENDER, true)).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
