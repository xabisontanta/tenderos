import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, type Call, type FakeResult } from "../support/fake-supabase";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: async () => (h.db as { client: unknown }).client }));

const queries = await import("@/lib/data/queries");

const ORG = "00000000-0000-4000-8000-000000000001";
const boom = (): FakeResult => ({ data: null, error: { code: "XX000", message: "connection reset" } });

describe("data queries do not turn a database error into an empty screen", () => {
  beforeEach(() => {
    h.db = fakeSupabase(boom, boom);
  });

  const cases: Array<[string, () => Promise<unknown>]> = [
    ["getAgentFloor", () => queries.getAgentFloor(ORG)],
    ["getRecentEvents", () => queries.getRecentEvents(ORG, { limit: 5 })],
    ["getRecentHandoffs", () => queries.getRecentHandoffs(ORG)],
    ["getPendingApprovals", () => queries.getPendingApprovals(ORG)],
    ["getApprovalHistory", () => queries.getApprovalHistory(ORG)],
    ["getDashboardData", () => queries.getDashboardData(ORG)],
    ["getWorkerHealth", () => queries.getWorkerHealth()],
    ["getUnreadNotifications", () => queries.getUnreadNotifications(ORG)],
    ["getQueueHealth", () => queries.getQueueHealth(ORG)],
    ["getTenderTitles", () => queries.getTenderTitles(["00000000-0000-4000-8000-0000000000aa"])],
  ];

  it.each(cases)("%s throws, saying what it could not load", async (_name, run) => {
    await expect(run()).rejects.toThrow(/Could not load .*connection reset/);
  });

  it("getAgentFloor also fails when only a later query fails", async () => {
    h.db = fakeSupabase((call: Call) => {
      if (call.table === "tenders") return boom();
      if (call.table === "agents") return { data: [{ id: "a1", current_task_id: null, current_tender_id: "t1" }], error: null };
      return { data: [], error: null };
    });
    await expect(queries.getAgentFloor(ORG)).rejects.toThrow(/Could not load tenders/);
  });
});

describe("getDashboardData", () => {
  it("returns the tender counts by status as the database counted them, so no page has to count rows", async () => {
    h.db = fakeSupabase(
      () => ({ data: [], error: null }),
      (name) =>
        name === "dashboard_counts"
          ? { data: { tenders: { DISCOVERED: 1500, QUALIFYING: 2, AWARDED: 3 }, cost_today: 1.5, cost_month: 20 }, error: null }
          : { data: null, error: null },
    );
    const d = await queries.getDashboardData(ORG);
    expect(d.tenders.byStatus).toEqual({ DISCOVERED: 1500, QUALIFYING: 2, AWARDED: 3 });
    expect(d.tenders.new).toBe(1500); // not capped at the API's 1000 rows
    expect(d.tenders.total).toBe(1505);
    expect(d.spend).toEqual({ today: 1.5, month: 20 });
  });
});
