import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  role: "owner" as string,
  rpc: vi.fn(),
  adminRpc: vi.fn(),
  logs: [] as Array<{ level: string; msg: string; fields: unknown }>,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/context", () => ({
  requireContext: async () => ({
    userId: "user-1",
    email: "owner@acme.test",
    organisation: { id: "org-1", name: "Acme", slug: "acme-trading" },
    role: h.role,
  }),
  canAdminister: (role: string) => role === "owner" || role === "admin",
}));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: async () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/supabase/admin", () => ({ getAdminSupabase: () => ({ rpc: h.adminRpc }) }));
vi.mock("@/lib/log", () => ({
  createLogger: () => {
    const emit = (level: string) => (msg: string, fields?: unknown) => void h.logs.push({ level, msg, fields });
    return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error"), child: () => ({}) };
  },
}));

const { exportOrganisationData } = await import("@/features/settings/actions");

const EXPORT = { generated_at: "2026-10-12T08:00:00Z", organisation: { id: "org-1" }, tenders: [] };

beforeEach(() => {
  h.role = "owner";
  h.logs.length = 0;
  h.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  h.adminRpc.mockReset().mockResolvedValue({ data: EXPORT, error: null });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T08:00:00Z"));
});

describe("exportOrganisationData", () => {
  it("gives the owner the organisation's export as a JSON file, naming who asked", async () => {
    const res = await exportOrganisationData();
    expect(res).toEqual({ ok: true, data: { filename: "tenderos-export-acme-trading-2026-10-12.json", json: JSON.stringify(EXPORT, null, 2) } });
    expect(h.adminRpc).toHaveBeenCalledWith("export_organisation_data", { p_org: "org-1", p_actor: "user-1" });
  });

  it("is limited per person before it asks the database for anything", async () => {
    await exportOrganisationData();
    expect(h.rpc).toHaveBeenCalledWith("hit_rate_limit", { p_action: "org.export", p_max: 3, p_window_seconds: 3600 });
    h.adminRpc.mockClear();
    h.rpc.mockResolvedValue({ data: null, error: { code: "P0429", message: "Too many requests; please wait and try again" } });
    const res = await exportOrganisationData();
    expect(res).toEqual({ ok: false, error: "Too many requests; please wait and try again" });
    expect(h.adminRpc).not.toHaveBeenCalled();
  });

  it.each(["admin", "operator", "viewer"])("is for the owner only, not a %s", async (role) => {
    h.role = role;
    const res = await exportOrganisationData();
    expect(res).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.adminRpc).not.toHaveBeenCalled();
  });

  it("reports a failed export plainly, without database internals", async () => {
    h.adminRpc.mockResolvedValue({ data: null, error: { code: "XX000", message: 'relation "x" does not exist' } });
    const res = await exportOrganisationData();
    expect(res).toEqual({ ok: false, error: "Could not prepare the export. Try again in a few minutes." });
    expect(h.logs.some((l) => l.level === "error")).toBe(true);
  });

  it("logs that an export happened without logging what was in it", async () => {
    await exportOrganisationData();
    const text = JSON.stringify(h.logs);
    expect(text).toContain("org-1");
    expect(text).not.toContain("owner@acme.test");
    expect(text).not.toContain("generated_at");
  });
});
