import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import type { Worker } from "@/workflows/worker";
import { DOCUMENT_BUCKET } from "@/lib/domain/documents";
import { addMember, bootstrapOrg, createTender, createUser, drainOrg, testPool, testWorker, type TestUser } from "./helpers";

let pool: Pool;
let worker: Worker;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let orgId: string;
let outsiderOrg: string;

async function addDocument(path: string, docType: string, title: string) {
  const up = await owner.client.storage.from(DOCUMENT_BUCKET).upload(path, new Blob(["%PDF-1.4\n"], { type: "application/pdf" }), {
    contentType: "application/pdf",
  });
  expect(up.error).toBeNull();
  const { data, error } = await owner.client.rpc("register_company_document", { p_org: orgId, p_doc_type: docType, p_title: title, p_path: path });
  expect(error).toBeNull();
  return data as string;
}

beforeAll(async () => {
  pool = testPool();
  worker = testWorker(pool);
  owner = await createUser("hard-owner");
  viewer = await createUser("hard-viewer");
  outsider = await createUser("hard-outsider");
  orgId = await bootstrapOrg(owner);
  await addMember(orgId, viewer.id, "viewer", pool);
  outsiderOrg = await bootstrapOrg(outsider);
});

afterAll(async () => {
  await pool.end();
});

describe("document access", () => {
  it("keeps director IDs, bank letters and proof of address to owners and admins", async () => {
    const ids = await addDocument(`${orgId}/ids/ids.pdf`, "director_ids", "Director IDs");
    const cipc = await addDocument(`${orgId}/cipc/cipc.pdf`, "cipc_registration", "CIPC");

    expect((await viewer.client.storage.from(DOCUMENT_BUCKET).download(`${orgId}/ids/ids.pdf`)).error).not.toBeNull();
    expect((await viewer.client.rpc("document_download", { p_id: ids })).error).not.toBeNull();
    expect((await viewer.client.storage.from(DOCUMENT_BUCKET).download(`${orgId}/cipc/cipc.pdf`)).error).toBeNull();
    const ok = await viewer.client.rpc("document_download", { p_id: cipc });
    expect(ok.data).toEqual([{ storage_path: `${orgId}/cipc/cipc.pdf`, file_name: "cipc.pdf" }]);
    expect((await owner.client.rpc("document_download", { p_id: ids })).error).toBeNull();
    expect((await outsider.client.rpc("document_download", { p_id: cipc })).error).not.toBeNull();

    const { rows } = await pool.query(`select count(*)::int as n from public.audit_logs where organisation_id = $1 and action = 'document.downloaded'`, [
      orgId,
    ]);
    expect(rows[0].n).toBe(2);
  });

  it("stops serving a file once its document is removed", async () => {
    const id = await addDocument(`${orgId}/old/old.pdf`, "csd_registration", "Old CSD");
    expect((await owner.client.rpc("archive_company_document", { p_id: id })).error).toBeNull();
    expect((await owner.client.storage.from(DOCUMENT_BUCKET).download(`${orgId}/old/old.pdf`)).error).not.toBeNull();
    expect((await owner.client.rpc("document_download", { p_id: id })).error).not.toBeNull();
  });
});

describe("database hardening", () => {
  it("limits every state-changing RPC inside the database", async () => {
    const fns = [
      "start_tender_workflow",
      "cancel_workflow",
      "retry_task",
      "transition_tender",
      "decide_approval",
      "set_agent_control",
      "set_kill_switch",
      "set_watched_provinces",
      "set_watched_methods",
      "register_company_document",
      "verify_company_document",
      "archive_company_document",
      "disconnect_email_account",
      "connect_email_account",
      "record_bid_delivery",
      "start_discovery",
      "document_download",
      "rerun_bid",
    ];
    const { rows } = await pool.query(`select proname, prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1)`, [fns]);
    expect(rows.map((r) => r.proname).sort()).toEqual([...fns].sort());
    for (const r of rows) expect(r.prosrc, r.proname).toContain("hit_rate_limit(");
  });

  it("rejects a tender that points at another organisation's source", async () => {
    const { rows } = await pool.query(`select id from public.tender_sources where organisation_id = $1 limit 1`, [outsiderOrg]);
    await expect(createTender(owner.client, orgId, { source_id: rows[0].id })).rejects.toBeTruthy();
  });

  it("records who changed the company profile, whatever the browser sends", async () => {
    const { error } = await owner.client
      .from("company_profiles")
      .insert({ organisation_id: orgId, legal_name: "Hardening Test (Pty) Ltd", updated_by: outsider.id } as never);
    expect(error).toBeNull();
    const { rows } = await pool.query(`select updated_by from public.company_profiles where organisation_id = $1`, [orgId]);
    expect(rows[0].updated_by).toBe(owner.id);
  });

  it("does not let users create or delete profile rows", async () => {
    expect((await owner.client.from("profiles").delete().eq("id", owner.id)).error).not.toBeNull();
    expect((await owner.client.from("profiles").insert({ id: outsider.id } as never)).error).not.toBeNull();
  });

  it("shows only whether a worker is alive", async () => {
    expect((await owner.client.from("worker_heartbeats").select("*")).error).not.toBeNull();
    const { data, error } = await owner.client.rpc("worker_health");
    expect(error).toBeNull();
    expect(Object.keys(data![0]).sort()).toEqual(["last_seen_at", "workers"]);
  });
});

describe("approval expiry", () => {
  it("expires undecided approvals after closing and stops the run", async () => {
    const tender = await createTender(owner.client, orgId, { reference_number: `EXP-${Date.now()}` });
    const { data: runId } = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    await drainOrg(worker, pool, orgId);
    const { data: approval } = await owner.client.from("approvals").select("id, status").eq("workflow_run_id", runId!).single();
    expect(approval!.status).toBe("PENDING");

    await pool.query(`update public.approvals set expires_at = now() - interval '1 minute' where id = $1`, [approval!.id]);
    const refused = await owner.client.rpc("decide_approval", { p_approval_id: approval!.id, p_approve: true, p_comments: "late" });
    expect(refused.error?.message).toMatch(/expired/);

    const { rows } = await pool.query(`select private.expire_approvals() as n`);
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
    await drainOrg(worker, pool, orgId);

    const { data: after } = await owner.client.from("approvals").select("status").eq("id", approval!.id).single();
    expect(after!.status).toBe("EXPIRED");
    const { data: run } = await owner.client.from("workflow_runs").select("status, outcome").eq("id", runId!).single();
    expect(run).toEqual({ status: "CANCELLED", outcome: "APPROVAL_EXPIRED" });
    const { data: t } = await owner.client.from("tenders").select("status").eq("id", tender.id).single();
    expect(t!.status).toBe("CANCELLED");
  });
});
