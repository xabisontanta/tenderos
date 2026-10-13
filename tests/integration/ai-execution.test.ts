import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENTS } from "@/agents/registry";
import { createLogger } from "@/lib/log";
import { Worker } from "@/workflows/worker";
import type { Pool } from "@/lib/db/pool";
import { FakeDocumentSource } from "../support/documents";
import { pipelineClient } from "../eval/fake-model";
import { fixtureById } from "../eval/fixtures";
import { bootstrapOrg, createTender, createUser, drainOrg, futureIso, testPool, type TestUser } from "./helpers";

// These tests need the local Supabase stack and are not part of `npm run test:unit`.
// They run real (non-simulation) tenders through the worker with a fake model and a fake document source.

const AI_ENV = {
  AI_ENABLED: "true",
  ANTHROPIC_API_KEY: "test-key-not-real",
  AI_MODEL_LOW: "model-low",
  AI_MODEL_MID: "model-mid",
  AI_MODEL_HIGH: "model-high",
  AI_PRICE_LOW: "0.1/0.5",
  AI_PRICE_MID: "2/10",
  AI_PRICE_HIGH: "4/20/0.2/5",
};

const fx = fixtureById("roads-rehabilitation")!;

let pool: Pool;
let owner: TestUser;

beforeAll(async () => {
  pool = testPool();
  owner = await createUser("ai-owner");
});

afterAll(async () => {
  await pool.end();
});

function aiWorker(env: Record<string, string | undefined>) {
  return new Worker(pool, {
    concurrency: 1,
    simulationStepMs: 0,
    logger: createLogger({ service: "test" }, "error"),
    ai: { env, client: pipelineClient(fx), documents: new FakeDocumentSource(fx.documents) },
  });
}

async function realRun(orgId: string) {
  const tender = await createTender(owner.client, orgId, {
    is_simulation: false,
    reference_number: `AI-${Date.now()}`,
    title: fx.tender.title ?? fx.title,
    issuing_organisation: fx.tender.issuing_organisation ?? "Test Municipality",
    province: "LIMPOPO",
    closing_at: futureIso(20),
  });
  const { data: runId, error } = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
  expect(error).toBeNull();
  return { tender, runId: runId as string };
}

/** The organisation's own switch (set_ai_settings does this in the app). The deployment's AI_ENABLED is the other half. */
const enableAi = (orgId: string) => pool.query(`update public.system_settings set ai_enabled = true where organisation_id = $1`, [orgId]);

const costRows = async (runId: string) =>
  (
    await pool.query(
      `select provider, model, input_tokens, output_tokens, cost_usd::float8 as cost_usd, is_simulated from public.cost_usage where workflow_run_id = $1 order by id`,
      [runId],
    )
  ).rows;

describe("AI execution on real tenders", () => {
  it("records real tokens and cost for AI steps, which is what the daily budget gate reads", async () => {
    // One organisation per user is enforced in the database, so every test gets its own owner.
    owner = await createUser("ai-owner");
    const orgId = await bootstrapOrg(owner);
    await enableAi(orgId);
    await pool.query(
      `insert into public.company_profiles (organisation_id, legal_name, cidb_grade, sectors, provinces) values ($1, 'Umzansi Civils (Pty) Ltd', '6CE', '{Construction}', '{LIMPOPO}')`,
      [orgId],
    );
    const { runId } = await realRun(orgId);
    await drainOrg(aiWorker(AI_ENV), pool, orgId);

    const rows = await costRows(runId);
    const ai = rows.filter((r) => r.provider === "anthropic");
    expect(ai.length).toBeGreaterThanOrEqual(2); // analysis and qualification
    for (const r of ai) {
      expect(r.is_simulated).toBe(false);
      expect(r.cost_usd).toBeGreaterThan(0);
      expect(r.input_tokens).toBeGreaterThan(0);
    }
    // Compliance is rules-only and costs nothing.
    expect(rows.some((r) => r.provider === "rules" && r.cost_usd === 0)).toBe(true);

    const { rows: tasks } = await pool.query(
      `select step_key, actual_cost_usd::float8 as cost, output from public.tasks where workflow_run_id = $1 and status = 'COMPLETED'`,
      [runId],
    );
    const analysis = tasks.find((t) => t.step_key === "analysis");
    expect(analysis.cost).toBeGreaterThan(0);
    expect(analysis.output.ai_generated).toBe(true);
    expect(analysis.output.requirements.some((r: { source: { kind: string } }) => r.source.kind === "TENDER_DOCUMENT")).toBe(true);
  });

  it("stays rules-only, at no cost, when the organisation has not switched AI on, even though the deployment allows it", async () => {
    // One organisation per user is enforced in the database, so every test gets its own owner.
    owner = await createUser("ai-owner");
    const orgId = await bootstrapOrg(owner);
    expect((await pool.query(`select ai_enabled from public.system_settings where organisation_id = $1`, [orgId])).rows[0].ai_enabled).toBe(false);
    const { runId } = await realRun(orgId);
    await drainOrg(aiWorker(AI_ENV), pool, orgId);
    const rows = await costRows(runId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.provider === "rules" && r.cost_usd === 0)).toBe(true);
  });

  it("stays rules-only, at no cost, when the deployment has not allowed AI, even though the organisation switched it on", async () => {
    owner = await createUser("ai-owner");
    const orgId = await bootstrapOrg(owner);
    await enableAi(orgId);
    for (const env of [
      { ...AI_ENV, AI_ENABLED: "false" },
      { ...AI_ENV, AI_ENABLED: undefined },
    ]) {
      const { runId } = await realRun(orgId);
      await drainOrg(aiWorker(env), pool, orgId);
      const rows = await costRows(runId);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.provider === "rules" && r.cost_usd === 0)).toBe(true);
    }
  });

  it("uses the organisation's switch as it is set through set_ai_settings, and stops when it is switched off", async () => {
    owner = await createUser("ai-owner");
    const orgId = await bootstrapOrg(owner);
    expect((await owner.client.rpc("set_ai_settings", { p_org: orgId, p_enabled: true, p_web_research: false })).error).toBeNull();
    const first = await realRun(orgId);
    await drainOrg(aiWorker(AI_ENV), pool, orgId);
    expect((await costRows(first.runId)).some((r) => r.provider === "anthropic")).toBe(true);

    expect((await owner.client.rpc("set_ai_settings", { p_org: orgId, p_enabled: false, p_web_research: false })).error).toBeNull();
    const second = await realRun(orgId);
    await drainOrg(aiWorker(AI_ENV), pool, orgId);
    expect((await costRows(second.runId)).every((r) => r.provider === "rules")).toBe(true);
  });

  it("refuses to run AI steps when the key is missing instead of falling back to rules", async () => {
    // One organisation per user is enforced in the database, so every test gets its own owner.
    owner = await createUser("ai-owner");
    const orgId = await bootstrapOrg(owner);
    await enableAi(orgId);
    const { runId } = await realRun(orgId);
    await drainOrg(aiWorker({ ...AI_ENV, ANTHROPIC_API_KEY: "" }), pool, orgId);
    const { rows } = await pool.query(`select status, error from public.tasks where workflow_run_id = $1 and step_key = 'analysis'`, [runId]);
    expect(rows[0].status).toBe("FAILED");
    expect(rows[0].error).toMatch(/ANTHROPIC_API_KEY/);
    // Steps before the refused one (intake) ran rules-only at no cost; nothing was billed to the AI provider.
    const rowsAfter = await costRows(runId);
    expect(rowsAfter.filter((r) => r.provider === "anthropic")).toEqual([]);
    expect(rowsAfter.every((r) => r.cost_usd === 0)).toBe(true);
  });

  it("stops the next AI step once the daily budget is spent", async () => {
    // One organisation per user is enforced in the database, so every test gets its own owner.
    owner = await createUser("ai-owner");
    const orgId = await bootstrapOrg(owner);
    await enableAi(orgId);
    await pool.query(`update public.system_settings set daily_ai_budget_usd = 0.005 where organisation_id = $1`, [orgId]);
    const { runId } = await realRun(orgId);
    await drainOrg(aiWorker(AI_ENV), pool, orgId);
    const { rows: events } = await pool.query(
      `select event_type, severity from public.agent_events where organisation_id = $1 and event_type = 'BUDGET_WARNING'`,
      [orgId],
    );
    expect(events.length).toBeGreaterThan(0);
    const { rows: run } = await pool.query(`select status from public.workflow_runs where id = $1`, [runId]);
    expect(run[0].status).toBe("BLOCKED");
  });

  it("refuses a tool that is not on the agent's stored list and logs a WARNING", async () => {
    // One organisation per user is enforced in the database, so every test gets its own owner.
    owner = await createUser("ai-owner");
    const orgId = await bootstrapOrg(owner);
    await enableAi(orgId);
    await pool.query(`update public.agents set allowed_tools = '{}' where organisation_id = $1 and slug = 'tender_analyst'`, [orgId]);
    const { runId } = await realRun(orgId);
    await drainOrg(aiWorker(AI_ENV), pool, orgId);
    const { rows } = await pool.query(`select severity, payload from public.agent_events where workflow_run_id = $1 and event_type = 'TOOL_REFUSED'`, [runId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("WARNING");
    expect(rows[0].payload.tool).toBe("tender.documents.read");
    const { rows: task } = await pool.query(`select status from public.tasks where workflow_run_id = $1 and step_key = 'analysis'`, [runId]);
    expect(task[0].status).toBe("FAILED");
  });
});

describe("stored tool lists", () => {
  it("match the registry for every agent a new organisation gets", async () => {
    // One organisation per user is enforced in the database, so every test gets its own owner.
    owner = await createUser("ai-owner");
    const orgId = await bootstrapOrg(owner);
    const { rows } = await pool.query(`select slug, allowed_tools from public.agents where organisation_id = $1`, [orgId]);
    for (const def of AGENTS) {
      const stored = rows.find((r) => r.slug === def.slug);
      expect([...(stored?.allowed_tools ?? [])].sort(), def.slug).toEqual([...def.allowedTools].sort());
    }
  });
});
