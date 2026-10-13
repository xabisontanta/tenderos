import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import { addMember, bootstrapOrg, createUser, testPool, type TestUser } from "./helpers";

/**
 * AI assistance settings (migration 070): who may change them, what the database refuses, what is audited, and the spend the
 * settings screen shows. The engine's use of the column is in ai-execution.test.ts. Each test makes its own owner because
 * one organisation per user is enforced.
 */
let pool: Pool;

type Level = "aal1" | "aal2";
interface Outcome {
  rows: Array<Record<string, unknown>>;
  error: { code?: string; message: string } | null;
}

/** One statement as `authenticated`, with a session at the given level (the claims PostgREST would set). */
async function as(user: Pick<TestUser, "id" | "email">, aal: Level, text: string, params: unknown[] = []): Promise<Outcome> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user.id, role: "authenticated", email: user.email, aal })]);
    const res = await client.query(text, params);
    await client.query("commit");
    return { rows: res.rows, error: null };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    const err = e as { code?: string; message: string };
    return { rows: [], error: { code: err.code, message: err.message } };
  } finally {
    client.release();
  }
}

interface Fixture {
  orgId: string;
  owner: TestUser;
  admin: TestUser;
  operator: TestUser;
  viewer: TestUser;
}

async function fixture(label: string): Promise<Fixture> {
  const [owner, admin, operator, viewer] = await Promise.all(["owner", "admin", "operator", "viewer"].map((r) => createUser(`${label}-${r}`)));
  const orgId = await bootstrapOrg(owner);
  await addMember(orgId, admin.id, "admin", pool);
  await addMember(orgId, operator.id, "operator", pool);
  await addMember(orgId, viewer.id, "viewer", pool);
  return { orgId, owner, admin, operator, viewer };
}

const settings = async (orgId: string) =>
  (
    await pool.query(
      `select ai_enabled, ai_web_research_enabled, daily_ai_budget_usd::float8 as budget from public.system_settings where organisation_id = $1`,
      [orgId],
    )
  ).rows[0] as { ai_enabled: boolean; ai_web_research_enabled: boolean; budget: number };

const auditActions = async (orgId: string) =>
  (await pool.query(`select action, metadata from public.audit_logs where organisation_id = $1 and action like 'settings.ai%' order by id`, [orgId])).rows;

beforeAll(() => {
  pool = testPool();
});

afterAll(async () => {
  await pool.end();
});

describe("the columns", () => {
  it("start off for a new organisation", async () => {
    const f = await fixture("ai-set-default");
    expect(await settings(f.orgId)).toMatchObject({ ai_enabled: false, ai_web_research_enabled: false });
  });

  it("cannot be written by a browser session directly", async () => {
    const f = await fixture("ai-set-direct");
    const { error } = await f.owner.client
      .from("system_settings")
      .update({ ai_enabled: true } as never)
      .eq("organisation_id", f.orgId);
    expect(error).not.toBeNull();
    expect((await settings(f.orgId)).ai_enabled).toBe(false);
  });

  it("cannot be switched on with no budget, or web research on without AI, by any writer", async () => {
    const f = await fixture("ai-set-constraints");
    await expect(
      pool.query(`update public.system_settings set daily_ai_budget_usd = 0, ai_enabled = true where organisation_id = $1`, [f.orgId]),
    ).rejects.toMatchObject({
      code: "23514",
    });
    await expect(pool.query(`update public.system_settings set ai_web_research_enabled = true where organisation_id = $1`, [f.orgId])).rejects.toMatchObject({
      code: "23514",
    });
    await pool.query(`update public.system_settings set ai_enabled = true where organisation_id = $1`, [f.orgId]);
    await expect(pool.query(`update public.system_settings set daily_ai_budget_usd = 0 where organisation_id = $1`, [f.orgId])).rejects.toMatchObject({
      code: "23514",
    });
  });
});

describe("set_ai_settings", () => {
  it("lets an owner switch AI on and off, audits each change and tells the team", async () => {
    const f = await fixture("ai-set-owner");
    expect((await f.owner.client.rpc("set_ai_settings", { p_org: f.orgId, p_enabled: true, p_web_research: false })).error).toBeNull();
    expect(await settings(f.orgId)).toMatchObject({ ai_enabled: true, ai_web_research_enabled: false });
    expect((await f.owner.client.rpc("set_ai_settings", { p_org: f.orgId, p_enabled: true, p_web_research: true })).error).toBeNull();
    expect(await settings(f.orgId)).toMatchObject({ ai_enabled: true, ai_web_research_enabled: true });
    expect((await f.owner.client.rpc("set_ai_settings", { p_org: f.orgId, p_enabled: false, p_web_research: false })).error).toBeNull();
    expect(await settings(f.orgId)).toMatchObject({ ai_enabled: false, ai_web_research_enabled: false });

    const audit = await auditActions(f.orgId);
    expect(audit.map((a) => a.action)).toEqual(["settings.ai_enabled", "settings.ai_updated", "settings.ai_disabled"]);
    expect(audit[0].metadata).toMatchObject({ ai_enabled: true, web_research: false, was_enabled: false });
    const { rows: who } = await pool.query(`select actor_user_id from public.audit_logs where organisation_id = $1 and action = 'settings.ai_enabled'`, [
      f.orgId,
    ]);
    expect(who[0].actor_user_id).toBe(f.owner.id);

    const { rows: notes } = await pool.query(`select user_id, kind from public.notifications where organisation_id = $1 and kind = 'AI_SETTINGS_CHANGED'`, [
      f.orgId,
    ]);
    expect(new Set(notes.map((n) => n.user_id))).toEqual(new Set([f.owner.id, f.admin.id, f.operator.id, f.viewer.id]));
  });

  it("lets an admin do it, and refuses an operator, a viewer and an outsider", async () => {
    const f = await fixture("ai-set-roles");
    const outsider = await createUser("ai-set-outsider");
    await bootstrapOrg(outsider);
    expect((await f.admin.client.rpc("set_ai_settings", { p_org: f.orgId, p_enabled: true, p_web_research: false })).error).toBeNull();
    for (const user of [f.operator, f.viewer, outsider]) {
      const { error } = await user.client.rpc("set_ai_settings", { p_org: f.orgId, p_enabled: false, p_web_research: false });
      expect(error?.code, user.email).toBe("42501");
    }
    expect((await settings(f.orgId)).ai_enabled).toBe(true);
  });

  it("refuses to switch AI on while the daily budget is zero, and says why", async () => {
    const f = await fixture("ai-set-nobudget");
    await pool.query(`update public.system_settings set daily_ai_budget_usd = 0 where organisation_id = $1`, [f.orgId]);
    const { error } = await f.owner.client.rpc("set_ai_settings", { p_org: f.orgId, p_enabled: true, p_web_research: false });
    expect(error?.code).toBe("23514");
    expect(error?.message).toMatch(/daily AI budget above zero/i);
    expect((await settings(f.orgId)).ai_enabled).toBe(false);
  });

  it("refuses web research without AI, and nulls", async () => {
    const f = await fixture("ai-set-web");
    const web = await f.owner.client.rpc("set_ai_settings", { p_org: f.orgId, p_enabled: false, p_web_research: true });
    expect(web.error?.code).toBe("23514");
    const nul = await as(f.owner, "aal1", `select public.set_ai_settings($1, null, false)`, [f.orgId]);
    expect(nul.error?.code).toBe("23514");
    expect((await settings(f.orgId)).ai_web_research_enabled).toBe(false);
  });

  it("writes no audit row when nothing changes", async () => {
    const f = await fixture("ai-set-noop");
    expect((await f.owner.client.rpc("set_ai_settings", { p_org: f.orgId, p_enabled: false, p_web_research: false })).error).toBeNull();
    expect(await auditActions(f.orgId)).toEqual([]);
  });

  it("is limited per person inside the database", async () => {
    const f = await fixture("ai-set-rate");
    let refused = 0;
    for (let i = 0; i < 25; i++) {
      const { error } = await f.owner.client.rpc("set_ai_settings", { p_org: f.orgId, p_enabled: i % 2 === 0, p_web_research: false });
      if (error?.code === "P0429") refused++;
    }
    expect(refused).toBeGreaterThan(0);
  });

  it("asks for a second factor when the organisation requires one", async () => {
    const f = await fixture("ai-set-aal");
    await pool.query(`update public.system_settings set require_mfa = true where organisation_id = $1`, [f.orgId]);
    const below = await as(f.owner, "aal1", `select public.set_ai_settings($1, true, false)`, [f.orgId]);
    expect(below.error?.code).toBe("P0403");
    expect((await settings(f.orgId)).ai_enabled).toBe(false);
    const ok = await as(f.owner, "aal2", `select public.set_ai_settings($1, true, false)`, [f.orgId]);
    expect(ok.error).toBeNull();
    expect((await settings(f.orgId)).ai_enabled).toBe(true);
  });
});

describe("set_ai_budget", () => {
  it("sets a positive budget, audits who changed it and from what", async () => {
    const f = await fixture("ai-bud-owner");
    expect((await f.owner.client.rpc("set_ai_budget", { p_org: f.orgId, p_daily_usd: 12.5 })).error).toBeNull();
    expect((await settings(f.orgId)).budget).toBe(12.5);
    const audit = await auditActions(f.orgId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "settings.ai_budget_changed", metadata: { daily_budget_usd: 12.5, was_daily_budget_usd: 5 } });
  });

  it("refuses zero, negative, null, over the cap and sub-cent amounts", async () => {
    const f = await fixture("ai-bud-bad");
    for (const bad of [0, -1, null, 1000.01, 5.001]) {
      const { error } = await f.owner.client.rpc("set_ai_budget", { p_org: f.orgId, p_daily_usd: bad as never });
      expect(error?.code, String(bad)).toBe("23514");
    }
    expect((await f.owner.client.rpc("set_ai_budget", { p_org: f.orgId, p_daily_usd: 1000 })).error).toBeNull();
    expect((await settings(f.orgId)).budget).toBe(1000);
  });

  it("is for owners and admins only", async () => {
    const f = await fixture("ai-bud-roles");
    expect((await f.admin.client.rpc("set_ai_budget", { p_org: f.orgId, p_daily_usd: 8 })).error).toBeNull();
    for (const user of [f.operator, f.viewer]) {
      expect((await user.client.rpc("set_ai_budget", { p_org: f.orgId, p_daily_usd: 9 })).error?.code).toBe("42501");
    }
    expect((await settings(f.orgId)).budget).toBe(8);
  });

  it("asks for a second factor when the organisation requires one", async () => {
    const f = await fixture("ai-bud-aal");
    await pool.query(`update public.system_settings set require_mfa = true where organisation_id = $1`, [f.orgId]);
    expect((await as(f.owner, "aal1", `select public.set_ai_budget($1, 9)`, [f.orgId])).error?.code).toBe("P0403");
    expect((await as(f.owner, "aal2", `select public.set_ai_budget($1, 9)`, [f.orgId])).error).toBeNull();
  });
});

describe("ai_spend", () => {
  const insertCost = (orgId: string, usd: number, createdAt: string, simulated = false) =>
    pool.query(
      `insert into public.cost_usage (organisation_id, provider, model, input_tokens, output_tokens, cost_usd, is_simulated, created_at)
       values ($1, 'anthropic', 'm', 1, 1, $2, $3, $4)`,
      [orgId, usd, simulated, createdAt],
    );

  it("sums today and this month in the database, in South African time, leaving simulated work out", async () => {
    const f = await fixture("ai-spend");
    const { rows } = await pool.query<{ day: string; month: string; last: string }>(
      `select date_trunc('day', now() at time zone 'Africa/Johannesburg') at time zone 'Africa/Johannesburg' as day,
              date_trunc('month', now() at time zone 'Africa/Johannesburg') at time zone 'Africa/Johannesburg' as month,
              (date_trunc('month', now() at time zone 'Africa/Johannesburg') - interval '1 hour') at time zone 'Africa/Johannesburg' as last`,
    );
    const dayStart = new Date(rows[0].day).getTime();
    const monthStart = new Date(rows[0].month).getTime();
    await insertCost(f.orgId, 1.25, new Date().toISOString());
    await insertCost(f.orgId, 0.75, new Date(dayStart + 1000).toISOString());
    await insertCost(f.orgId, 99, new Date().toISOString(), true);
    // Before today but this month (only when today is not the first of the month), and last month.
    if (monthStart < dayStart) await insertCost(f.orgId, 4, new Date(monthStart + 1000).toISOString());
    await insertCost(f.orgId, 1000, new Date(monthStart - 3_600_000).toISOString());
    const earlierThisMonth = monthStart < dayStart ? 4 : 0;

    const { data, error } = await f.viewer.client.rpc("ai_spend", { p_org: f.orgId });
    expect(error).toBeNull();
    const row = (data as unknown as Array<{ today_usd: number; month_usd: number }>)[0];
    expect(Number(row.today_usd)).toBeCloseTo(2, 6);
    expect(Number(row.month_usd)).toBeCloseTo(2 + earlierThisMonth, 6);
  });

  it("is for members of the organisation only", async () => {
    const f = await fixture("ai-spend-priv");
    const outsider = await createUser("ai-spend-outsider");
    await bootstrapOrg(outsider);
    await insertCost(f.orgId, 3, new Date().toISOString());
    expect((await outsider.client.rpc("ai_spend", { p_org: f.orgId })).error?.code).toBe("42501");
    expect((await outsider.client.rpc("ai_spend", { p_org: randomUUID() })).error?.code).toBe("42501");
  });
});
