import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import { bootstrapOrg, createUser, testPool, type TestUser } from "./helpers";

/**
 * The API returns at most 1000 rows (max_rows), so a page that fetched rows and counted or summed them in the
 * browser silently stopped at 1000. These totals are computed by the database.
 */
let pool: Pool;
let owner: TestUser;
let outsider: TestUser;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  pool = testPool();
  owner = await createUser("agg-owner");
  outsider = await createUser("agg-outsider");
  orgId = await bootstrapOrg(owner);
  await bootstrapOrg(outsider);
  const { rows } = await pool.query<{ id: string }>(`select id from public.agents where organisation_id = $1 and slug = 'tender_analyst'`, [orgId]);
  agentId = rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("agent_usage_totals", () => {
  it("sums every usage row, however many there are, not the first thousand", async () => {
    await pool.query(
      `insert into public.cost_usage (organisation_id, agent_id, provider, model, input_tokens, output_tokens, cost_usd, is_simulated)
       select $1, $2, 'anthropic', 'test-model', 100, 50, 0.000123, false from generate_series(1, 1200)`,
      [orgId, agentId],
    );
    const res = await owner.client.rpc("agent_usage_totals", { p_agent_id: agentId });
    expect(res.error).toBeNull();
    expect(res.data).toEqual({ calls: 1200, cost_usd: 0.1476, input_tokens: 120_000, output_tokens: 60_000, all_simulated: false });
  });

  it("says when all recorded usage is simulated, and returns zeros for an agent with none", async () => {
    const { rows } = await pool.query<{ id: string }>(`select id from public.agents where organisation_id = $1 and slug = 'compliance'`, [orgId]);
    expect((await owner.client.rpc("agent_usage_totals", { p_agent_id: rows[0].id })).data).toEqual({
      calls: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      all_simulated: false,
    });
    await pool.query(`insert into public.cost_usage (organisation_id, agent_id, provider, model, is_simulated) values ($1, $2, 'simulation', 'none', true)`, [
      orgId,
      rows[0].id,
    ]);
    expect((await owner.client.rpc("agent_usage_totals", { p_agent_id: rows[0].id })).data).toMatchObject({ calls: 1, all_simulated: true });
  });

  it("is limited by row level security: another organisation sees nothing, and anonymous callers are refused", async () => {
    expect((await outsider.client.rpc("agent_usage_totals", { p_agent_id: agentId })).data).toMatchObject({ calls: 0, cost_usd: 0 });
    const { rows } = await pool.query(`select has_function_privilege('anon', 'public.agent_usage_totals(uuid)', 'execute') as anon`);
    expect(rows[0].anon).toBe(false);
  });
});

describe("dashboard_counts", () => {
  it("counts tenders per status past the API's row limit", async () => {
    await pool.query(
      `insert into public.tenders (organisation_id, title, issuing_organisation, closing_at, is_simulation)
       select $1, 'Bulk tender ' || n, 'Test Municipality', now() + interval '30 days', true from generate_series(1, 1100) n`,
      [orgId],
    );
    const { data, error } = await owner.client.rpc("dashboard_counts", {
      p_org: orgId,
      p_day_start: new Date(Date.now() - 86_400_000).toISOString(),
      p_month_start: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });
    expect(error).toBeNull();
    expect((data as { tenders: Record<string, number> }).tenders.DISCOVERED).toBe(1100);
    // The point of the RPC: reading the rows instead stops at 1000.
    const rows = await owner.client.from("tenders").select("id").eq("organisation_id", orgId);
    expect(rows.data).toHaveLength(1000);
  }, 120_000);

  it("pages past the API's row limit, and a page past the end is the error the Discover page redirects on", async () => {
    const second = await owner.client.from("tenders").select("id", { count: "exact" }).eq("organisation_id", orgId).order("id").range(1000, 1049);
    expect(second.error).toBeNull();
    expect(second.count).toBe(1100);
    expect(second.data).toHaveLength(50);
    const past = await owner.client.from("tenders").select("id", { count: "exact" }).eq("organisation_id", orgId).order("id").range(5000, 5049);
    expect(past.error?.code).toBe("PGRST103");
  }, 60_000);
});
