import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import { createLogger } from "@/lib/log";
import { Worker } from "@/workflows/worker";
import { DELIVERY_WITHDRAWABLE_STATUSES, isDeliveryLocked } from "@/lib/domain/delivery-lock";
import { DOCUMENT_BUCKET } from "@/lib/domain/documents";
import { ALL_TENDER_STATUSES } from "@/lib/domain/tender-state";
import { addMember, bootstrapOrg, createTender, createUser, drainOrg, futureIso, testPool, testWorker, type Client, type TestUser } from "./helpers";
import { etendersFetcher, etendersRow, futureSaLocal } from "../fixtures/etenders";

let pool: Pool;
let worker: Worker;
let owner: TestUser;
let admin: TestUser;
let operator: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let orgId: string;

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

/** A simulation bid that has reached the approval gate: tender READY_FOR_APPROVAL, approval PENDING. */
async function bidAtApproval() {
  const tender = await createTender(operator.client as Client, orgId, {
    reference_number: `LOCK-${randomUUID().slice(0, 8)}`,
    submission_method: "EMAIL",
    submission_destination: "bids@municipality.gov.za",
  });
  const started = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
  expect(started.error).toBeNull();
  await drainOrg(worker, pool, orgId);
  const { data: approval } = await owner.client.from("approvals").select("id, status").eq("workflow_run_id", started.data!).single();
  expect(approval!.status).toBe("PENDING");
  return { tenderId: tender.id, runId: started.data!, approvalId: approval!.id };
}

/** A real bid the owner has approved: tender SUBMITTING, submission ACTION_REQUIRED, waiting for a person to deliver it. */
async function approvedBid() {
  const tender = await createTender(owner.client as Client, orgId, {
    is_simulation: false,
    reference_number: `LOCKR-${randomUUID().slice(0, 8)}`,
    submission_method: "EMAIL",
    submission_destination: "bids@municipality.gov.za",
  });
  const started = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
  expect(started.error).toBeNull();
  await drainOrg(worker, pool, orgId);
  const { data: approval } = await owner.client.from("approvals").select("id").eq("workflow_run_id", started.data!).single();
  expect((await owner.client.rpc("decide_approval", { p_approval_id: approval!.id, p_approve: true, p_comments: "Approved" })).error).toBeNull();
  await drainOrg(worker, pool, orgId);
  const { data: sub } = await owner.client.from("submission_records").select("id, status").eq("workflow_run_id", started.data!).single();
  expect(sub!.status).toBe("ACTION_REQUIRED");
  return { tenderId: tender.id, runId: started.data!, approvalId: approval!.id, submissionId: sub!.id };
}

async function tenderRow(id: string) {
  const { rows } = await pool.query(`select status, submission_destination, submission_method, source_url, closing_at from public.tenders where id = $1`, [id]);
  return rows[0];
}

beforeAll(async () => {
  pool = testPool();
  worker = testWorker(pool);
  owner = await createUser("lock-owner");
  admin = await createUser("lock-admin");
  operator = await createUser("lock-operator");
  viewer = await createUser("lock-viewer");
  outsider = await createUser("lock-outsider");
  orgId = await bootstrapOrg(owner);
  await addMember(orgId, admin.id, "admin", pool);
  await addMember(orgId, operator.id, "operator", pool);
  await addMember(orgId, viewer.id, "viewer", pool);
  await bootstrapOrg(outsider);

  for (const [type, title, expires] of [
    ["cipc_registration", "CIPC CoR 14.3", undefined],
    ["csd_registration", "CSD summary", undefined],
    ["tax_compliance", "TCS PIN letter", inDays(200)],
    ["sbd_declarations", "SBD 4 and 6.1", undefined],
  ] as const) {
    const path = `${orgId}/${type}/doc.pdf`;
    const up = await owner.client.storage
      .from(DOCUMENT_BUCKET)
      .upload(path, new Blob(["%PDF-1.4\n"], { type: "application/pdf" }), { contentType: "application/pdf" });
    expect(up.error).toBeNull();
    expect(
      (await owner.client.rpc("register_company_document", { p_org: orgId, p_doc_type: type, p_title: title, p_path: path, p_expires_at: expires })).error,
    ).toBeNull();
  }
  await owner.client.from("company_profiles").insert({ organisation_id: orgId, legal_name: "Acme Trading (Pty) Ltd", bbbee_level: 2 });
});

afterAll(async () => {
  await pool.end();
});

describe("the lock", () => {
  it("agrees with the TypeScript copy for every tender status", async () => {
    for (const status of ALL_TENDER_STATUSES) {
      const { rows } = await pool.query(`select private.delivery_locked($1::uuid, $2::public.tender_status) as locked`, [randomUUID(), status]);
      expect(rows[0].locked, status).toBe(isDeliveryLocked(status, []));
    }
  });

  it("is withdrawn only from statuses the state machine can walk back to preparation", async () => {
    const { rows } = await pool.query(`select prosrc from pg_proc where proname = 'change_tender_delivery' and pronamespace = 'public'::regnamespace`);
    for (const status of DELIVERY_WITHDRAWABLE_STATUSES) expect(rows[0].prosrc, status).toContain(`'${status}'`);
    expect(rows[0].prosrc).toContain("hit_rate_limit(");
  });
});

describe("delivery details before the bid goes for approval", () => {
  it("can still be edited by an operator", async () => {
    const t = await createTender(operator.client as Client, orgId, { reference_number: `OPEN-${randomUUID().slice(0, 8)}` });
    const edit = await operator.client
      .from("tenders")
      .update({
        submission_destination: "tenders@city.gov.za",
        submission_method: "EMAIL",
        source_url: "https://city.gov.za/tender",
        closing_at: futureIso(20),
      })
      .eq("id", t.id);
    expect(edit.error).toBeNull();
    expect((await tenderRow(t.id)).submission_destination).toBe("tenders@city.gov.za");
  });
});

describe("delivery details once a bid is waiting for approval", () => {
  it("cannot be changed by an operator, an admin or the owner through the table", async () => {
    const bid = await bidAtApproval();
    const before = await tenderRow(bid.tenderId);
    const edits = [
      { submission_destination: "attacker@example.org" },
      { submission_method: "PHYSICAL" as const },
      { source_url: "https://evil.example/portal" },
      { closing_at: futureIso(40) },
    ];
    for (const user of [operator, admin, owner]) {
      for (const patch of edits) {
        const res = await user.client.from("tenders").update(patch).eq("id", bid.tenderId);
        expect(res.error?.message, JSON.stringify(patch)).toMatch(/locked/i);
      }
    }
    expect(await tenderRow(bid.tenderId)).toEqual(before);
    // Everything else about the tender is still editable.
    expect((await operator.client.from("tenders").update({ sector: "Furniture" }).eq("id", bid.tenderId)).error).toBeNull();
  });

  it("cannot be changed by the system either, except a closing date the portal moved", async () => {
    const bid = await bidAtApproval();
    await expect(pool.query(`update public.tenders set submission_destination = 'elsewhere' where id = $1`, [bid.tenderId])).rejects.toThrow(/locked/i);
    await expect(pool.query(`update public.tenders set source_url = 'https://evil.example/' where id = $1`, [bid.tenderId])).rejects.toThrow(/locked/i);
    await pool.query(`update public.tenders set closing_at = closing_at + interval '2 days' where id = $1`, [bid.tenderId]);
  });
});

describe("delivery details once a bid is approved", () => {
  it("cannot be redirected by an operator", async () => {
    const bid = await approvedBid();
    const before = await tenderRow(bid.tenderId);
    expect(before.status).toBe("SUBMITTING");
    const res = await operator.client.from("tenders").update({ submission_destination: "attacker@example.org" }).eq("id", bid.tenderId);
    expect(res.error?.message).toMatch(/locked/i);
    expect(await tenderRow(bid.tenderId)).toEqual(before);
    const { data: approval } = await owner.client.from("approvals").select("status").eq("id", bid.approvalId).single();
    expect(approval!.status).toBe("APPROVED");
  });
});

describe("change_tender_delivery", () => {
  it("is for owners and admins, with a reason and a real change", async () => {
    const bid = await bidAtApproval();
    const args = { p_tender_id: bid.tenderId, p_changes: { submission_destination: "new@municipality.gov.za" }, p_reason: "Corrected in addendum 2" };
    for (const user of [operator, viewer, outsider]) expect((await user.client.rpc("change_tender_delivery", args)).error).not.toBeNull();
    expect((await admin.client.rpc("change_tender_delivery", { ...args, p_reason: "" })).error?.message).toMatch(/reason/i);
    expect((await admin.client.rpc("change_tender_delivery", { ...args, p_changes: {} })).error?.message).toMatch(/nothing to change/i);
    expect((await admin.client.rpc("change_tender_delivery", { ...args, p_changes: { title: "x" } })).error?.message).toMatch(/cannot be changed/i);
    expect((await admin.client.rpc("change_tender_delivery", { ...args, p_changes: { submission_method: "TELEPATHY" } })).error).not.toBeNull();
    expect((await admin.client.rpc("change_tender_delivery", { ...args, p_changes: { source_url: "javascript:alert(1)" } })).error).not.toBeNull();
    expect(
      (await admin.client.rpc("change_tender_delivery", { ...args, p_changes: { closing_at: new Date(Date.now() - 86_400_000).toISOString() } })).error
        ?.message,
    ).toMatch(/future/i);
    expect(
      (await admin.client.rpc("change_tender_delivery", { ...args, p_changes: { submission_destination: "bids@municipality.gov.za" } })).error?.message,
    ).toMatch(/nothing to change/i);
    const { data: approval } = await owner.client.from("approvals").select("status").eq("id", bid.approvalId).single();
    expect(approval!.status).toBe("PENDING");
  });

  it("withdraws a pending approval, sends the bid back to preparation and says who changed what and why", async () => {
    const bid = await bidAtApproval();
    const newClosing = futureIso(30);
    const res = await admin.client.rpc("change_tender_delivery", {
      p_tender_id: bid.tenderId,
      p_changes: { submission_destination: "new@municipality.gov.za", closing_at: newClosing },
      p_reason: "Corrected in addendum 2",
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ withdrawn: true, approvals_cancelled: 1, status: "PREPARING_BID" });

    const row = await tenderRow(bid.tenderId);
    expect(row).toMatchObject({ status: "PREPARING_BID", submission_destination: "new@municipality.gov.za" });
    expect(new Date(row.closing_at).getTime()).toBe(new Date(newClosing).getTime());
    const { data: approval } = await owner.client.from("approvals").select("status, decided_by").eq("id", bid.approvalId).single();
    expect(approval).toEqual({ status: "CANCELLED", decided_by: null });
    const { data: run } = await owner.client.from("workflow_runs").select("status, outcome").eq("id", bid.runId).single();
    expect(run).toEqual({ status: "CANCELLED", outcome: "DELIVERY_CHANGED" });
    const { data: pending } = await owner.client.from("approvals").select("id").eq("tender_id", bid.tenderId).eq("status", "PENDING");
    expect(pending).toEqual([]);

    const { rows: history } = await pool.query(
      `select from_status, to_status, reason, actor_user_id from public.tender_status_history where tender_id = $1 order by id desc limit 1`,
      [bid.tenderId],
    );
    expect(history[0]).toMatchObject({ from_status: "READY_FOR_APPROVAL", to_status: "PREPARING_BID", actor_user_id: admin.id });
    expect(history[0].reason).toMatch(/Delivery details changed/);
    const { rows: audit } = await pool.query(
      `select actor_user_id, metadata from public.audit_logs where action = 'tender.delivery_changed' and resource_id = $1`,
      [bid.tenderId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBe(admin.id);
    expect(audit[0].metadata).toMatchObject({
      reason: "Corrected in addendum 2",
      withdrew_approval: true,
      changes: { submission_destination: { from: "bids@municipality.gov.za", to: "new@municipality.gov.za" } },
    });
    const { rows: ev } = await pool.query(`select 1 from public.agent_events where tender_id = $1 and event_type = 'TENDER_DELIVERY_CHANGED'`, [bid.tenderId]);
    expect(ev).toHaveLength(1);

    // The bid can be prepared again and reaches a fresh approval that expires at the new closing time.
    expect((await operator.client.rpc("rerun_bid", { p_tender_id: bid.tenderId })).error).toBeNull();
    await drainOrg(worker, pool, orgId);
    const { data: fresh } = await owner.client.from("approvals").select("id, status, expires_at").eq("tender_id", bid.tenderId).eq("status", "PENDING");
    expect(fresh).toHaveLength(1);
    expect(fresh![0].id).not.toBe(bid.approvalId);
    expect(new Date(fresh![0].expires_at!).getTime()).toBe(new Date(newClosing).getTime());
  });

  it("withdraws an approved bid that is waiting to be delivered, so the old pack cannot go to the new address", async () => {
    const bid = await approvedBid();
    const res = await owner.client.rpc("change_tender_delivery", {
      p_tender_id: bid.tenderId,
      p_changes: { submission_method: "PHYSICAL", submission_destination: "Tender box, Civic Centre" },
      p_reason: "Municipality switched to a tender box",
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ withdrawn: true, approvals_cancelled: 1, status: "PREPARING_BID" });
    expect(await tenderRow(bid.tenderId)).toMatchObject({
      status: "PREPARING_BID",
      submission_method: "PHYSICAL",
      submission_destination: "Tender box, Civic Centre",
    });
    const { data: approval } = await owner.client.from("approvals").select("status").eq("id", bid.approvalId).single();
    expect(approval!.status).toBe("CANCELLED");
    const { data: sub } = await owner.client.from("submission_records").select("status").eq("id", bid.submissionId).single();
    expect(sub!.status).toBe("FAILED");
    const delivered = await owner.client.rpc("record_bid_delivery", { p_submission_id: bid.submissionId, p_reference: "x" });
    expect(delivered.error?.message).toMatch(/already recorded as failed/i);
    // Back to preparation through the transitions the state machine allows, each one on the record.
    const { rows: statuses } = await pool.query(`select to_status from public.tender_status_history where tender_id = $1 order by id desc limit 3`, [
      bid.tenderId,
    ]);
    expect(statuses.map((s) => s.to_status)).toEqual(["PREPARING_BID", "READY_FOR_APPROVAL", "SUBMISSION_FAILED"]);
  });

  it("refuses once the bid has been delivered", async () => {
    const bid = await approvedBid();
    expect((await owner.client.rpc("record_bid_delivery", { p_submission_id: bid.submissionId, p_reference: "receipt-1" })).error).toBeNull();
    const res = await admin.client.rpc("change_tender_delivery", {
      p_tender_id: bid.tenderId,
      p_changes: { submission_destination: "late@x.gov.za" },
      p_reason: "Too late",
    });
    expect(res.error?.message).toMatch(/delivered/i);
    expect((await tenderRow(bid.tenderId)).submission_destination).toBe("bids@municipality.gov.za");
  });

  it("changes a tender nobody has put forward yet without withdrawing anything", async () => {
    const t = await createTender(operator.client as Client, orgId, { reference_number: `FREE-${randomUUID().slice(0, 8)}` });
    const res = await admin.client.rpc("change_tender_delivery", {
      p_tender_id: t.id,
      p_changes: { source_url: "https://city.gov.za/new" },
      p_reason: "Link moved",
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ withdrawn: false, approvals_cancelled: 0, status: "DISCOVERED" });
    expect((await tenderRow(t.id)).source_url).toBe("https://city.gov.za/new");
  });
});

describe("a portal refresh of a bid that is waiting for approval", () => {
  it("moves the closing date but never the delivery address, and says so", async () => {
    const scout = await createUser("lock-scout");
    const pondOrg = await bootstrapOrg(scout);
    const row = etendersRow({
      id: 951001,
      tender_No: "LOCK-PORTAL-1",
      province: "Gauteng",
      delivery: "Submit to bids@example.gov.za",
      closing_Date: futureSaLocal(20),
    });
    const run = async (fetchRows: unknown[]) => {
      const w = new Worker(pool, {
        concurrency: 1,
        simulationStepMs: 0,
        logger: createLogger({ service: "test" }, "error"),
        fetcher: etendersFetcher(fetchRows).fetcher,
      });
      const started = await scout.client.rpc("start_discovery", { p_org: pondOrg, p_provinces: ["GAUTENG"] });
      expect(started.error).toBeNull();
      await drainOrg(w, pool, pondOrg);
      const { rows } = await pool.query(`select status, error from public.discovery_runs where id = $1`, [started.data]);
      return rows[0];
    };
    expect(await run([row])).toMatchObject({ status: "COMPLETED" });
    const { rows: stored } = await pool.query(
      `select id, submission_destination, closing_at from public.tenders where organisation_id = $1 and source_ref = '951001'`,
      [pondOrg],
    );
    expect(stored[0].submission_destination).toBe("bids@example.gov.za");

    // A person has put the bid forward: an approval is waiting.
    await pool.query(
      `insert into public.approvals (organisation_id, type, tender_id, summary, status) values ($1, 'BID_SUBMISSION', $2, 'Approve', 'PENDING')`,
      [pondOrg, stored[0].id],
    );

    const moved = { ...row, closing_Date: futureSaLocal(30), delivery: "Submit to someone-else@example.gov.za" };
    expect(await run([moved])).toMatchObject({ status: "COMPLETED", error: null });
    const { rows: after } = await pool.query(`select submission_destination, closing_at from public.tenders where id = $1`, [stored[0].id]);
    expect(after[0].submission_destination).toBe("bids@example.gov.za");
    expect(new Date(after[0].closing_at).getTime()).toBe(new Date(moved.closing_Date + "+02:00").getTime());
    const { rows: ev } = await pool.query(
      `select severity, summary from public.agent_events where tender_id = $1 and event_type = 'TENDER_UPDATED' order by created_at`,
      [stored[0].id],
    );
    expect(ev.map((e) => e.summary).join("\n")).toMatch(/delivery details/i);
  });
});
