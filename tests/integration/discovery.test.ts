import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "@/lib/db/pool";
import { createLogger } from "@/lib/log";
import { Worker } from "@/workflows/worker";
import { DOCUMENT_BUCKET } from "@/lib/domain/documents";
import { bootstrapOrg, createUser, drainOrg, env, type TestUser } from "./helpers";
import { etendersFetcher, etendersRow, futureSaLocal } from "../fixtures/etenders";

let pool: Pool;
let owner: TestUser;
let orgId: string;
const rows = [
  etendersRow({ id: 900001, tender_No: "GT-OPEN-1", province: "Gauteng" }),
  etendersRow({ id: 900002, tender_No: "KZN-OPEN-1", province: "KwaZulu-Natal", department: "eThekwini Municipality" }),
  etendersRow({ id: 900003, tender_No: "GT-CLOSED-1", province: "Gauteng", closing_Date: futureSaLocal(-2) }),
  etendersRow({ id: 900004, tender_No: "GT-SOON-1", province: "Gauteng", closing_Date: futureSaLocal(1) }),
];

function worker(fetchRows = rows) {
  return new Worker(pool, {
    concurrency: 1,
    simulationStepMs: 0,
    logger: createLogger({ service: "test" }, "error"),
    fetcher: etendersFetcher(fetchRows).fetcher,
  });
}

beforeAll(async () => {
  pool = createPool(env().db, 6);
  owner = await createUser("scout");
  orgId = await bootstrapOrg(owner);
});

afterAll(async () => {
  await pool.end();
});

describe("province discovery", () => {
  it("requires a province and an authorised member", async () => {
    const none = await owner.client.rpc("start_discovery", { p_org: orgId });
    expect(none.error?.message).toMatch(/at least one province/);
    const viewer = await createUser("viewer");
    const denied = await viewer.client.rpc("start_discovery", { p_org: orgId, p_provinces: ["GAUTENG"] });
    expect(denied.error).not.toBeNull();
  });

  it("finds open tenders in the watched province and hands them to the agents", async () => {
    const set = await owner.client.rpc("set_watched_provinces", { p_org: orgId, p_provinces: ["GAUTENG"], p_auto_run: true });
    expect(set.error).toBeNull();
    const { data: runId, error } = await owner.client.rpc("start_discovery", { p_org: orgId });
    expect(error).toBeNull();

    await drainOrg(worker(), pool, orgId);

    const { data: run } = await owner.client.from("discovery_runs").select("*").eq("id", runId!).single();
    expect(run).toMatchObject({ status: "COMPLETED", scanned: 4, matched: 2, created_tenders: 2, started_workflows: 1 });

    const { data: tenders } = await owner.client.from("tenders").select("reference_number, province, is_simulation, status").eq("organisation_id", orgId);
    expect(tenders!.map((t) => t.reference_number).sort()).toEqual(["GT-OPEN-1", "GT-SOON-1"]);
    expect(tenders!.every((t) => t.province === "GAUTENG" && !t.is_simulation)).toBe(true);

    // Without a company profile the live workflow stops at the compliance gate.
    const open = tenders!.find((t) => t.reference_number === "GT-OPEN-1")!;
    expect(open.status).toBe("MISSING_INFORMATION");
    const soon = tenders!.find((t) => t.reference_number === "GT-SOON-1")!;
    expect(soon.status).toBe("DISCOVERED");

    const { data: scoutTask } = await owner.client
      .from("tasks")
      .select("status, type, output")
      .eq("organisation_id", orgId)
      .eq("type", "discovery.scan")
      .single();
    expect(scoutTask).toMatchObject({ status: "COMPLETED", output: { matched: 2, created: 2 } });
    const { rows: events } = await pool.query(`select event_type from public.agent_events where organisation_id = $1`, [orgId]);
    expect(events.map((e) => e.event_type)).toEqual(expect.arrayContaining(["DISCOVERY_STARTED", "TENDER_DISCOVERED", "DISCOVERY_COMPLETED"]));
  });

  it("stays blocked on typed-in profile facts, resumes once documents are uploaded, then stops for approval and hands over the pack", async () => {
    const { error } = await owner.client.from("company_profiles").insert({
      organisation_id: orgId,
      legal_name: "Scout Test Trading (Pty) Ltd",
      registration_number: "2015/123456/07",
      csd_number: "MAAA0123456",
      tax_pin: "ABC123XYZ9",
      tax_pin_expires_at: new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10),
      bbbee_level: 2,
      authorised_signatory: "A. Director",
    });
    expect(error).toBeNull();
    await drainOrg(worker(), pool, orgId);
    const { data: stillBlocked } = await owner.client.from("tenders").select("status").eq("reference_number", "GT-OPEN-1").single();
    expect(stillBlocked!.status).toBe("MISSING_INFORMATION");

    const tcs = new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10);
    for (const [type, expires] of [
      ["cipc_registration", undefined],
      ["csd_registration", undefined],
      ["tax_compliance", tcs],
      ["sbd_declarations", undefined],
    ] as const) {
      const path = `${orgId}/${type}/doc.pdf`;
      expect((await owner.client.storage.from(DOCUMENT_BUCKET).upload(path, new Blob(["%PDF-1.4\n"], { type: "application/pdf" }))).error).toBeNull();
      const reg = await owner.client.rpc("register_company_document", { p_org: orgId, p_doc_type: type, p_title: type, p_path: path, p_expires_at: expires });
      expect(reg.error).toBeNull();
    }
    await drainOrg(worker(), pool, orgId);

    const { data: run } = await owner.client.from("workflow_runs").select("id, status, workflow_key").eq("organisation_id", orgId).single();
    expect(run).toMatchObject({ status: "WAITING_APPROVAL", workflow_key: "tender_bid" });
    const { data: approval } = await owner.client.from("approvals").select("id").eq("workflow_run_id", run!.id).single();
    const decided = await owner.client.rpc("decide_approval", { p_approval_id: approval!.id, p_approve: true, p_comments: "Approved for delivery" });
    expect(decided.error).toBeNull();
    await drainOrg(worker(), pool, orgId);

    const { data: after } = await owner.client.from("workflow_runs").select("status, error").eq("id", run!.id).single();
    expect(after!.status).toBe("BLOCKED");
    expect(after!.error).toMatch(/Bid pack approved/);
    const { data: record } = await owner.client.from("submission_records").select("status, is_simulation").eq("workflow_run_id", run!.id).single();
    expect(record).toEqual({ status: "ACTION_REQUIRED", is_simulation: false });
  });

  it("only picks up the delivery methods the organisation chose", async () => {
    const viewerless = await owner.client.rpc("set_watched_methods", { p_org: orgId, p_methods: [] });
    expect(viewerless.error?.message).toMatch(/at least one/);
    expect((await owner.client.rpc("set_watched_methods", { p_org: orgId, p_methods: ["EMAIL"] })).error).toBeNull();
    const mixed = [
      etendersRow({ id: 900101, tender_No: "GT-EMAIL-1", province: "Gauteng", delivery: "Submit to bids@example.gov.za" }),
      etendersRow({ id: 900102, tender_No: "GT-BOX-1", province: "Gauteng" }),
    ];
    const { data: runId } = await owner.client.rpc("start_discovery", { p_org: orgId, p_provinces: ["GAUTENG"] });
    await drainOrg(worker(mixed), pool, orgId);
    const { data: run } = await owner.client.from("discovery_runs").select("methods, matched, created_tenders").eq("id", runId!).single();
    expect(run).toEqual({ methods: ["EMAIL"], matched: 1, created_tenders: 1 });
    const { data: t } = await owner.client.from("tenders").select("submission_method, submission_destination").eq("reference_number", "GT-EMAIL-1").single();
    expect(t).toEqual({ submission_method: "EMAIL", submission_destination: "bids@example.gov.za" });
    const { count } = await owner.client.from("tenders").select("id", { count: "exact", head: true }).eq("reference_number", "GT-BOX-1");
    expect(count).toBe(0);
    await owner.client.rpc("set_watched_methods", { p_org: orgId, p_methods: ["ELECTRONIC_PORTAL", "EMAIL", "PHYSICAL", "UNKNOWN"] });
  });

  it("does not store the same tender twice", async () => {
    const { data: runId } = await owner.client.rpc("start_discovery", { p_org: orgId, p_provinces: ["GAUTENG", "KWAZULU_NATAL"] });
    await drainOrg(worker(), pool, orgId);
    const { data: run } = await owner.client.from("discovery_runs").select("matched, created_tenders").eq("id", runId!).single();
    expect(run).toEqual({ matched: 3, created_tenders: 1 });
  });

  it("refreshes a stored tender when eTenders moves its closing date", async () => {
    const moved = rows.map((r) => (r.tender_No === "KZN-OPEN-1" ? { ...r, closing_Date: futureSaLocal(30) } : r));
    const { data: before } = await owner.client.from("tenders").select("id, closing_at").eq("reference_number", "KZN-OPEN-1").single();
    await owner.client.rpc("start_discovery", { p_org: orgId, p_provinces: ["GAUTENG", "KWAZULU_NATAL"] });
    await drainOrg(worker(moved), pool, orgId);
    const { data: after } = await owner.client.from("tenders").select("id, closing_at").eq("reference_number", "KZN-OPEN-1").single();
    expect(after!.id).toBe(before!.id);
    expect(new Date(after!.closing_at).getTime()).toBe(new Date(moved.find((r) => r.tender_No === "KZN-OPEN-1")!.closing_Date + "+02:00").getTime());
    const { rows: ev } = await pool.query(`select summary from public.agent_events where tender_id = $1 and event_type = 'TENDER_UPDATED'`, [after!.id]);
    expect(ev[0]?.summary).toMatch(/Closing date changed on eTenders/);
  });

  it("records a failed scan when the portal is down", async () => {
    const down = new Worker(pool, {
      concurrency: 1,
      simulationStepMs: 0,
      logger: createLogger({ service: "test" }, "error"),
      fetcher: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const { data: runId } = await owner.client.rpc("start_discovery", { p_org: orgId, p_provinces: ["GAUTENG"] });
    await drainOrg(down, pool, orgId);
    const { data: run } = await owner.client.from("discovery_runs").select("status, error").eq("id", runId!).single();
    expect(run!.status).toBe("FAILED");
    expect(run!.error).toMatch(/HTTP 503/);
  });
});
