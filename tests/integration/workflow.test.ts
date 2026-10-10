import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import type { Worker } from "@/workflows/worker";
import { bootstrapOrg, createTender, createUser, drainOrg, futureIso, testPool, testWorker, type TestUser } from "./helpers";

let pool: Pool;
let worker: Worker;
let owner: TestUser;
let orgId: string;

beforeAll(async () => {
  pool = testPool();
  worker = testWorker(pool);
  owner = await createUser("owner");
  orgId = await bootstrapOrg(owner);
});

afterAll(async () => {
  await pool.end();
});

async function eventTypes(runId: string): Promise<string[]> {
  const { rows } = await pool.query(`select event_type from public.agent_events where workflow_run_id = $1 order by created_at, id`, [runId]);
  return rows.map((r) => r.event_type);
}

describe("simulated bid workflow (first milestone)", () => {
  it("runs end to end with real persisted state, handoffs, approval and simulated submission", async () => {
    const tender = await createTender(owner.client, orgId, { reference_number: `SIM-${Date.now()}` });
    expect(tender.status).toBe("DISCOVERED");

    const { data: runId, error } = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    expect(error).toBeNull();

    await drainOrg(worker, pool, orgId);

    // Stops at the approval gate.
    const { data: run1 } = await owner.client.from("workflow_runs").select("*").eq("id", runId!).single();
    expect(run1!.status).toBe("WAITING_APPROVAL");
    const { data: t1 } = await owner.client.from("tenders").select("status").eq("id", tender.id).single();
    expect(t1!.status).toBe("READY_FOR_APPROVAL");

    const { data: approvals } = await owner.client.from("approvals").select("*").eq("workflow_run_id", runId!);
    expect(approvals).toHaveLength(1);
    expect(approvals![0].status).toBe("PENDING");
    expect(approvals![0].type).toBe("BID_SUBMISSION");

    const { data: subAgent } = await owner.client.from("agents").select("status").eq("organisation_id", orgId).eq("slug", "submission").single();
    expect(subAgent!.status).toBe("NEEDS_APPROVAL");

    // Human approves.
    const { error: decideErr } = await owner.client.rpc("decide_approval", { p_approval_id: approvals![0].id, p_approve: true, p_comments: "OK" });
    expect(decideErr).toBeNull();
    await drainOrg(worker, pool, orgId);

    const { data: run2 } = await owner.client.from("workflow_runs").select("*").eq("id", runId!).single();
    expect(run2!.status).toBe("COMPLETED");
    expect(run2!.outcome).toBe("SUBMITTED_SIMULATION");

    const { data: t2 } = await owner.client.from("tenders").select("status").eq("id", tender.id).single();
    expect(t2!.status).toBe("SUBMITTED");

    // Every step produced a completed task and a handoff into it.
    const { data: tasks } = await owner.client.from("tasks").select("step_key,status,output").eq("workflow_run_id", runId!).order("created_at");
    expect(tasks!.map((t) => t.step_key)).toEqual(["intake", "analysis", "qualification", "compliance", "proposal", "pricing", "qa", "approval", "submission"]);
    expect(tasks!.every((t) => t.status === "COMPLETED")).toBe(true);

    const { data: handoffs } = await owner.client.from("handoffs").select("handoff_type,status").eq("workflow_run_id", runId!).order("created_at");
    expect(handoffs).toHaveLength(9);
    expect(handoffs!.every((h) => h.status === "ACCEPTED" || h.handoff_type === "QA_COMPLETED")).toBe(true);

    const { data: submission } = await owner.client.from("submission_records").select("*").eq("tender_id", tender.id).single();
    expect(submission!.is_simulation).toBe(true);
    expect(submission!.status).toBe("SUBMITTED");
    expect(submission!.package_hash).toMatch(/^[a-f0-9]{64}$/);

    const types = await eventTypes(runId!);
    for (const t of ["WORKFLOW_STARTED", "AGENT_STARTED_TASK", "AGENT_COMPLETED_TASK", "HANDOFF_CREATED", "HANDOFF_ACCEPTED", "TENDER_QUALIFIED", "COMPLIANCE_FAIL", "QA_PASS", "APPROVAL_REQUIRED", "APPROVAL_GRANTED", "SUBMISSION_COMPLETED", "WORKFLOW_COMPLETED"]) {
      expect(types).toContain(t);
    }
    expect(types.indexOf("APPROVAL_GRANTED")).toBeLessThan(types.indexOf("SUBMISSION_COMPLETED"));

    // Tender history recorded every transition.
    const { data: history } = await owner.client.from("tender_status_history").select("to_status").eq("tender_id", tender.id).order("created_at");
    expect(history!.map((h) => h.to_status)).toEqual([
      "DISCOVERED", "INGESTING", "ANALYSING", "QUALIFYING", "QUALIFIED", "COMPLIANCE_REVIEW", "PREPARING_BID",
      "PRICING", "QUALITY_ASSURANCE", "READY_FOR_APPROVAL", "APPROVED", "SUBMITTING", "SUBMITTED",
    ]);

    // Simulated work costs nothing and says so.
    const { data: costs } = await owner.client.from("cost_usage").select("cost_usd,is_simulated").eq("workflow_run_id", runId!);
    expect(costs!.length).toBeGreaterThan(0);
    expect(costs!.every((c) => c.is_simulated && Number(c.cost_usd) === 0)).toBe(true);

    // Agents return to idle once the run ends.
    const { data: agents } = await owner.client.from("agents").select("slug,status").eq("organisation_id", orgId);
    expect(agents!.filter((a) => a.status !== "IDLE")).toEqual([]);

    // An audit trail exists for the run.
    const { data: audit } = await owner.client.from("audit_logs").select("action").eq("correlation_id", run2!.correlation_id);
    expect(audit!.map((a) => a.action)).toEqual(expect.arrayContaining(["workflow.requested", "workflow.started", "approval.granted", "submission.completed"]));
  });

  it("rejects a tender that fails a hard disqualifier and does not continue", async () => {
    const tender = await createTender(owner.client, orgId, { closing_at: new Date(Date.now() + 10 * 3_600_000).toISOString() });
    const { data: runId } = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    await drainOrg(worker, pool, orgId);
    const { data: run } = await owner.client.from("workflow_runs").select("status,outcome").eq("id", runId!).single();
    expect(run).toEqual({ status: "COMPLETED", outcome: "REJECTED" });
    const { data: t } = await owner.client.from("tenders").select("status").eq("id", tender.id).single();
    expect(t!.status).toBe("REJECTED");
    const { data: tasks } = await owner.client.from("tasks").select("step_key").eq("workflow_run_id", runId!);
    expect(tasks!.map((x) => x.step_key).sort()).toEqual(["analysis", "intake", "qualification"]);
    const { data: q } = await owner.client.from("tasks").select("output").eq("workflow_run_id", runId!).eq("step_key", "qualification").single();
    const out = q!.output as { decision: string; hard_disqualifiers: string[] };
    expect(out.decision).toBe("REJECTED");
    expect(out.hard_disqualifiers[0]).toMatch(/Closing date/);
  });

  it("stops the workflow when the approval is rejected", async () => {
    const tender = await createTender(owner.client, orgId);
    const { data: runId } = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    await drainOrg(worker, pool, orgId);
    const { data: approval } = await owner.client.from("approvals").select("id").eq("workflow_run_id", runId!).single();

    const noReason = await owner.client.rpc("decide_approval", { p_approval_id: approval!.id, p_approve: false });
    expect(noReason.error?.message).toMatch(/reason is required/);

    await owner.client.rpc("decide_approval", { p_approval_id: approval!.id, p_approve: false, p_comments: "Pricing not confirmed" });
    await drainOrg(worker, pool, orgId);
    const { data: run } = await owner.client.from("workflow_runs").select("status,outcome").eq("id", runId!).single();
    expect(run).toEqual({ status: "CANCELLED", outcome: "APPROVAL_REJECTED" });
    const { data: t } = await owner.client.from("tenders").select("status").eq("id", tender.id).single();
    expect(t!.status).toBe("PREPARING_BID");
    const { count } = await owner.client.from("submission_records").select("*", { count: "exact", head: true }).eq("tender_id", tender.id);
    expect(count).toBe(0);
  });

  it("prevents duplicate workflows for the same tender", async () => {
    const tender = await createTender(owner.client, orgId);
    const first = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    expect(first.error).toBeNull();
    const second = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    expect(second.error).not.toBeNull();
    await owner.client.rpc("cancel_workflow", { p_run_id: first.data!, p_reason: "test cleanup" });
    await drainOrg(worker, pool, orgId);
  });

  it("refuses the simulated workflow on a tender not marked as simulation", async () => {
    const tender = await createTender(owner.client, orgId, { is_simulation: false });
    const { error } = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    expect(error?.message).toMatch(/simulation tenders/);
  });
});

describe("failure handling", () => {
  it("retries a transient failure with backoff and then succeeds", async () => {
    const tender = await createTender(owner.client, orgId);
    const { data: runId } = await owner.client.rpc("start_tender_workflow", {
      p_tender_id: tender.id,
      p_options: { fail_step: "analysis", fail_times: 2 },
    });
    await drainOrg(worker, pool, orgId);
    const { data: task } = await owner.client.from("tasks").select("status,retry_count").eq("workflow_run_id", runId!).eq("step_key", "analysis").single();
    expect(task).toEqual({ status: "COMPLETED", retry_count: 2 });
    const types = await eventTypes(runId!);
    expect(types.filter((t) => t === "AGENT_FAILED_TASK")).toHaveLength(2);
    const { data: run } = await owner.client.from("workflow_runs").select("status").eq("id", runId!).single();
    expect(run!.status).toBe("WAITING_APPROVAL");
    await owner.client.rpc("cancel_workflow", { p_run_id: runId!, p_reason: "test cleanup" });
    await drainOrg(worker, pool, orgId);
  });

  it("blocks the run after retries are exhausted, dead-letters the job, and resumes on operator retry", async () => {
    const tender = await createTender(owner.client, orgId);
    const { data: runId } = await owner.client.rpc("start_tender_workflow", {
      p_tender_id: tender.id,
      p_options: { fail_step: "compliance", fail_times: 4 },
    });
    await drainOrg(worker, pool, orgId);

    const { data: task } = await owner.client.from("tasks").select("id,status,retry_count,error").eq("workflow_run_id", runId!).eq("step_key", "compliance").single();
    expect(task!.status).toBe("FAILED");
    expect(task!.retry_count).toBe(3);
    expect(task!.error).toMatch(/Injected simulation failure/);

    const { data: run } = await owner.client.from("workflow_runs").select("status,error").eq("id", runId!).single();
    expect(run!.status).toBe("BLOCKED");

    const { data: agent } = await owner.client.from("agents").select("status").eq("organisation_id", orgId).eq("slug", "compliance").single();
    expect(agent!.status).toBe("FAILED");

    const { rows: dead } = await pool.query(`select count(*)::int as n from public.jobs where status = 'DEAD' and payload ->> 'task_id' = $1`, [task!.id]);
    expect(dead[0].n).toBe(1);

    const { data: notes } = await owner.client.from("notifications").select("kind").eq("kind", "WORKFLOW_BLOCKED");
    expect(notes!.length).toBeGreaterThan(0);

    // Earlier work is intact.
    const { data: done } = await owner.client.from("tasks").select("step_key").eq("workflow_run_id", runId!).eq("status", "COMPLETED");
    expect(done!.map((d) => d.step_key).sort()).toEqual(["analysis", "intake", "qualification"]);

    // Operator retry: retry_count resets, so the 4th injected failure no longer applies after one more attempt.
    await pool.query(`update public.workflow_runs set options = '{}'::jsonb where id = $1`, [runId]);
    const { error } = await owner.client.rpc("retry_task", { p_task_id: task!.id });
    expect(error).toBeNull();
    await drainOrg(worker, pool, orgId);
    const { data: run2 } = await owner.client.from("workflow_runs").select("status").eq("id", runId!).single();
    expect(run2!.status).toBe("WAITING_APPROVAL");
    await owner.client.rpc("cancel_workflow", { p_run_id: runId!, p_reason: "test cleanup" });
    await drainOrg(worker, pool, orgId);
  });

  it("defers work for a paused agent and resumes when the agent is resumed", async () => {
    const { data: analyst } = await owner.client.from("agents").select("id").eq("organisation_id", orgId).eq("slug", "tender_analyst").single();
    expect((await owner.client.rpc("set_agent_control", { p_agent_id: analyst!.id, p_action: "pause", p_reason: "maintenance" })).error).toBeNull();

    const tender = await createTender(owner.client, orgId);
    const { data: runId } = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    await drainOrg(worker, pool, orgId);
    const { data: waiting } = await owner.client.from("tasks").select("status,blocked_reason").eq("workflow_run_id", runId!).eq("step_key", "analysis").single();
    expect(waiting).toEqual({ status: "WAITING", blocked_reason: "Agent paused by operator" });
    const { data: pausedAgent } = await owner.client.from("agents").select("status").eq("id", analyst!.id).single();
    expect(pausedAgent!.status).toBe("PAUSED");

    await owner.client.rpc("set_agent_control", { p_agent_id: analyst!.id, p_action: "resume" });
    await drainOrg(worker, pool, orgId);
    const { data: done } = await owner.client.from("tasks").select("status").eq("workflow_run_id", runId!).eq("step_key", "analysis").single();
    expect(done!.status).toBe("COMPLETED");
    await owner.client.rpc("cancel_workflow", { p_run_id: runId!, p_reason: "test cleanup" });
    await drainOrg(worker, pool, orgId);
  });

  it("holds all work while the kill switch is engaged", async () => {
    const tender = await createTender(owner.client, orgId, { closing_at: futureIso(20) });
    const { data: runId } = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    await owner.client.rpc("set_kill_switch", { p_org: orgId, p_engaged: true, p_reason: "test" });
    await drainOrg(worker, pool, orgId);
    const { data: intake } = await owner.client.from("tasks").select("status,blocked_reason").eq("workflow_run_id", runId!).eq("step_key", "intake").single();
    expect(intake).toEqual({ status: "WAITING", blocked_reason: "Emergency kill switch engaged" });

    const blocked = await createTender(owner.client, orgId);
    const { error } = await owner.client.rpc("start_tender_workflow", { p_tender_id: blocked.id });
    expect(error?.message).toMatch(/kill switch/);

    await owner.client.rpc("set_kill_switch", { p_org: orgId, p_engaged: false, p_reason: "test done" });
    await drainOrg(worker, pool, orgId);
    const { data: run } = await owner.client.from("workflow_runs").select("status").eq("id", runId!).single();
    expect(run!.status).toBe("WAITING_APPROVAL");
    await owner.client.rpc("cancel_workflow", { p_run_id: runId!, p_reason: "test cleanup" });
    await drainOrg(worker, pool, orgId);
  });
});
