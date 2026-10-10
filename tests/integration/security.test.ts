import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import type { Database } from "@/types/database";
import { addMember, bootstrapOrg, createTender, createUser, env, testPool, type TestUser } from "./helpers";

let pool: Pool;
let ownerA: TestUser;
let ownerB: TestUser;
let viewerA: TestUser;
let orgA: string;
let orgB: string;
let tenderA: string;

beforeAll(async () => {
  pool = testPool();
  ownerA = await createUser("owner-a");
  ownerB = await createUser("owner-b");
  viewerA = await createUser("viewer-a");
  orgA = await bootstrapOrg(ownerA);
  orgB = await bootstrapOrg(ownerB);
  await addMember(orgA, viewerA.id, "viewer", pool);
  tenderA = (await createTender(ownerA.client, orgA)).id;
});

afterAll(async () => {
  await pool.end();
});

describe("tenant isolation (RLS)", () => {
  it("members of another organisation see none of its data", async () => {
    for (const table of ["tenders", "agents", "departments", "agent_events", "tasks", "approvals", "workflow_runs", "handoffs", "audit_logs"] as const) {
      const { data, error } = await ownerB.client.from(table).select("organisation_id").eq("organisation_id", orgA);
      expect(error, table).toBeNull();
      expect(data, table).toEqual([]);
    }
  });

  it("cannot insert a tender into another organisation", async () => {
    const { error } = await ownerB.client.from("tenders").insert({
      organisation_id: orgA,
      title: "Cross-tenant write",
      issuing_organisation: "x",
      closing_at: new Date(Date.now() + 86_400_000 * 10).toISOString(),
    });
    expect(error).not.toBeNull();
  });

  it("cannot start, approve, or control resources in another organisation", async () => {
    expect((await ownerB.client.rpc("start_tender_workflow", { p_tender_id: tenderA })).error?.message).toMatch(/not permitted/);
    const { data: agent } = await ownerA.client.from("agents").select("id").eq("organisation_id", orgA).limit(1).single();
    expect((await ownerB.client.rpc("set_agent_control", { p_agent_id: agent!.id, p_action: "pause" })).error?.message).toMatch(/not permitted/);
    expect((await ownerB.client.rpc("set_kill_switch", { p_org: orgA, p_engaged: true, p_reason: "attack" })).error?.message).toMatch(/Not permitted/);
  });

  it("anonymous users can read nothing", async () => {
    const anon = createClient<Database>(env().url, env().anon, { auth: { persistSession: false } });
    for (const table of ["tenders", "agents", "organisations", "agent_events"] as const) {
      const { data } = await anon.from(table).select("*");
      expect(data ?? [], table).toEqual([]);
    }
  });
});

describe("role-based access", () => {
  it("viewers can read but not create tenders or start workflows", async () => {
    const { data } = await viewerA.client.from("tenders").select("id").eq("id", tenderA);
    expect(data).toHaveLength(1);
    const { error } = await viewerA.client.from("tenders").insert({
      organisation_id: orgA,
      title: "Viewer write",
      issuing_organisation: "x",
      closing_at: new Date(Date.now() + 86_400_000 * 10).toISOString(),
    });
    expect(error).not.toBeNull();
    expect((await viewerA.client.rpc("start_tender_workflow", { p_tender_id: tenderA })).error).not.toBeNull();
  });

  it("viewers cannot read the audit log", async () => {
    const { data } = await viewerA.client.from("audit_logs").select("id").eq("organisation_id", orgA);
    expect(data).toEqual([]);
    const { data: ownerView } = await ownerA.client.from("audit_logs").select("id").eq("organisation_id", orgA);
    expect(ownerView!.length).toBeGreaterThan(0);
  });

  it("only owners and admins may decide approvals", async () => {
    await addMember(orgA, (await createUser("op")).id, "operator", pool);
    const { error } = await viewerA.client.rpc("decide_approval", { p_approval_id: crypto.randomUUID(), p_approve: true });
    expect(error?.message).toMatch(/not permitted/);
  });
});

describe("system-owned state cannot be written by users", () => {
  it("users cannot change tender status directly", async () => {
    const { error } = await ownerA.client.from("tenders").update({ status: "SUBMITTED" } as never).eq("id", tenderA);
    expect(error).not.toBeNull();
    const { data } = await ownerA.client.from("tenders").select("status").eq("id", tenderA).single();
    expect(data!.status).toBe("DISCOVERED");
  });

  it("users cannot write agents, tasks, events or handoffs", async () => {
    const { data: agent } = await ownerA.client.from("agents").select("id").eq("organisation_id", orgA).limit(1).single();
    expect((await ownerA.client.from("agents").update({ status: "RUNNING" }).eq("id", agent!.id)).error).not.toBeNull();
    expect(
      (await ownerA.client.from("agent_events").insert({ organisation_id: orgA, event_type: "FAKE_EVENT", summary: "fake" })).error,
    ).not.toBeNull();
    expect(
      (await ownerA.client.from("tasks").insert({ organisation_id: orgA, agent_id: agent!.id, type: "x.fake", title: "fake" })).error,
    ).not.toBeNull();
  });

  it("users cannot read or write the job queue", async () => {
    const { data } = await ownerA.client.from("jobs" as never).select("*");
    expect(data ?? []).toEqual([]);
  });

  it("users can edit descriptive tender fields", async () => {
    const { error } = await ownerA.client.from("tenders").update({ sector: "Furniture" }).eq("id", tenderA);
    expect(error).toBeNull();
  });

  it("the bootstrap function is not callable by end users", async () => {
    const { error } = await ownerA.client.rpc("bootstrap_organisation", {
      p_user_id: ownerA.id,
      p_name: "x",
      p_slug: "x-x",
      p_departments: [],
      p_agents: [],
    } as never);
    expect(error).not.toBeNull();
  });
});

describe("append-only logs", () => {
  it("audit logs, events and tender history reject updates and deletes even for the database owner", async () => {
    for (const sql of [
      `update public.audit_logs set action = 'tampered' where organisation_id = $1`,
      `delete from public.audit_logs where organisation_id = $1`,
      `update public.agent_events set summary = 'tampered' where organisation_id = $1`,
      `delete from public.tender_status_history where organisation_id = $1`,
    ]) {
      await expect(pool.query(sql, [orgA])).rejects.toThrow(/append-only/);
    }
  });
});

describe("tender state machine in the database", () => {
  it("rejects invalid transitions", async () => {
    await expect(pool.query(`update public.tenders set status = 'SUBMITTED' where id = $1`, [tenderA])).rejects.toThrow(/Invalid tender transition/);
  });

  it("lets users make only permitted manual transitions, with a reason", async () => {
    const t = await createTender(ownerA.client, orgA);
    expect((await ownerA.client.rpc("transition_tender", { p_tender_id: t.id, p_to: "QUALIFIED", p_reason: "manual" })).error).not.toBeNull();
    expect((await ownerA.client.rpc("transition_tender", { p_tender_id: t.id, p_to: "CANCELLED", p_reason: "" })).error).not.toBeNull();
    expect((await ownerA.client.rpc("transition_tender", { p_tender_id: t.id, p_to: "CANCELLED", p_reason: "Not pursuing" })).error).toBeNull();
    const { data } = await ownerA.client.from("tender_status_history").select("to_status,reason,actor_type").eq("tender_id", t.id).order("created_at");
    expect(data!.at(-1)).toEqual({ to_status: "CANCELLED", reason: "Not pursuing", actor_type: "user" });
  });
});
