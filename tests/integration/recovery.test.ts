import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import type { Worker } from "@/workflows/worker";
import { bootstrapOrg, createTender, createUser, drainOrg, testPool, testWorker, type TestUser } from "./helpers";

let pool: Pool;
let worker: Worker;
let owner: TestUser;
let orgId: string;

beforeAll(async () => {
  pool = testPool();
  worker = testWorker(pool);
  owner = await createUser("recover-owner");
  orgId = await bootstrapOrg(owner);
});

afterAll(async () => {
  await pool.end();
});

describe("recovering a bid", () => {
  it("prepares a bid again after the approver sends it back, reusing the earlier analysis", async () => {
    const tender = await createTender(owner.client, orgId, { reference_number: `RERUN-${Date.now()}` });
    const { data: firstRun } = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    await drainOrg(worker, pool, orgId);
    const { data: approval } = await owner.client.from("approvals").select("id").eq("workflow_run_id", firstRun!).single();
    expect(
      (await owner.client.rpc("decide_approval", { p_approval_id: approval!.id, p_approve: false, p_comments: "Fix the method statement" })).error,
    ).toBeNull();
    await drainOrg(worker, pool, orgId);
    const { data: rejected } = await owner.client.from("tenders").select("status").eq("id", tender.id).single();
    expect(rejected!.status).toBe("PREPARING_BID");
    // Before this fix the tender was stuck: workflows only start from DISCOVERED.
    expect((await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id })).error).not.toBeNull();

    const { data: secondRun, error } = await owner.client.rpc("rerun_bid", { p_tender_id: tender.id });
    expect(error).toBeNull();
    await drainOrg(worker, pool, orgId);

    const { data: run } = await owner.client.from("workflow_runs").select("status, options").eq("id", secondRun!).single();
    expect(run!.status).toBe("WAITING_APPROVAL");
    const { data: steps } = await owner.client.from("tasks").select("step_key").eq("workflow_run_id", secondRun!).order("created_at");
    expect(steps!.map((s) => s.step_key)).toEqual(["compliance", "proposal", "pricing", "qa", "approval"]);
    const { data: t } = await owner.client.from("tenders").select("status").eq("id", tender.id).single();
    expect(t!.status).toBe("READY_FOR_APPROVAL");
    // Not offered while that run is waiting for approval.
    expect((await owner.client.rpc("rerun_bid", { p_tender_id: tender.id })).error).not.toBeNull();
  });

  it("refuses to prepare a bid again from any other state", async () => {
    const tender = await createTender(owner.client, orgId, { reference_number: `NORERUN-${Date.now()}` });
    const res = await owner.client.rpc("rerun_bid", { p_tender_id: tender.id });
    expect(res.error?.message).toMatch(/sent back by the approver or failed by QA/);
  });
});

describe("jobs that never finish", () => {
  it("gives up on a job whose lock keeps expiring and blocks its run", async () => {
    const tender = await createTender(owner.client, orgId, { reference_number: `CRASH-${Date.now()}` });
    const { data: runId } = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    // Simulate a worker that crashed on every attempt: the job is back in the queue with no attempts left.
    await pool.query(`update public.jobs set attempts = max_attempts where organisation_id = $1 and kind = 'workflow.start' and status = 'QUEUED'`, [orgId]);
    await drainOrg(worker, pool, orgId);
    const { rows: job } = await pool.query(`select status, last_error from public.jobs where payload ->> 'workflow_run_id' = $1`, [runId]);
    expect(job[0]).toMatchObject({ status: "DEAD" });
    expect(job[0].last_error).toMatch(/never finished/);
    const { data: run } = await owner.client.from("workflow_runs").select("status, error").eq("id", runId!).single();
    expect(run!.status).toBe("BLOCKED");
    expect(run!.error).toMatch(/System error/);
  });
});

describe("dashboard counts", () => {
  it("counts tenders by status in the database", async () => {
    const { data, error } = await owner.client.rpc("dashboard_counts", {
      p_org: orgId,
      p_day_start: new Date(Date.now() - 86_400_000).toISOString(),
      p_month_start: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });
    expect(error).toBeNull();
    const counts = data as { tenders: Record<string, number>; cost_today: number };
    const { count } = await owner.client.from("tenders").select("id", { count: "exact", head: true }).eq("organisation_id", orgId);
    expect(Object.values(counts.tenders).reduce((a, b) => a + b, 0)).toBe(count);
    expect(Number(counts.cost_today)).toBe(0);
  });
});
