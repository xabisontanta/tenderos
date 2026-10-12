import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "@/lib/db/pool";
import { createLogger } from "@/lib/log";
import { Worker } from "@/workflows/worker";
import { DOCUMENT_BUCKET } from "@/lib/domain/documents";
import { bootstrapOrg, createUser, drainOrg, env, type TestUser } from "./helpers";
import { etendersFetcher, etendersRow, futureSaLocal, nulRow, unreadableRows, untitledRow } from "../fixtures/etenders";

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

describe("scan resilience", () => {
  let scout: TestUser;
  let scoutOrg: string;
  let n = 960000;
  const good = (count: number, over: Record<string, unknown> = {}) =>
    Array.from({ length: count }, () => etendersRow({ id: ++n, tender_No: `RES-${n}`, province: "Gauteng", ...over }));

  async function scan(feed: unknown[], maxInvalidRatio?: number) {
    const w = new Worker(pool, {
      concurrency: 1,
      simulationStepMs: 0,
      logger: createLogger({ service: "test" }, "error"),
      fetcher: etendersFetcher(feed).fetcher,
      discovery: maxInvalidRatio === undefined ? undefined : { maxInvalidRatio },
    });
    // start_discovery allows six scans in five minutes; these tests run more.
    await pool.query(`delete from private.rate_limits where key like $1`, [`${scout.id}:start_discovery%`]);
    const started = await scout.client.rpc("start_discovery", { p_org: scoutOrg, p_provinces: ["GAUTENG"] });
    expect(started.error).toBeNull();
    await drainOrg(w, pool, scoutOrg);
    const { rows } = await pool.query(
      `select status, error, scanned, matched, created_tenders, rows_seen, rows_skipped from public.discovery_runs where id = $1`,
      [started.data],
    );
    return rows[0];
  }
  const tenderCount = async () =>
    (await pool.query(`select count(*)::int as n from public.tenders where organisation_id = $1`, [scoutOrg])).rows[0].n as number;

  beforeAll(async () => {
    scout = await createUser("resilient");
    scoutOrg = await bootstrapOrg(scout);
  });

  it("keeps the rest of the scan when some rows are dirty: strips NUL, titles the untitled, counts the unreadable", async () => {
    const feed = [...good(30), nulRow({ id: 960901 }), untitledRow({ id: 960902, province: "Gauteng" }), ...unreadableRows()];
    const run = await scan(feed);
    // 6 of the 38 rows cannot be used (3 unreadable, no closing date, an unparseable date, no organisation): 16 percent.
    expect(run).toMatchObject({ status: "COMPLETED", error: null, rows_seen: 38, rows_skipped: 6, scanned: 35, matched: 32, created_tenders: 32 });

    const { rows: nul } = await pool.query(
      `select title, reference_number, issuing_organisation, documents from public.tenders where organisation_id = $1 and source_ref = '960901'`,
      [scoutOrg],
    );
    expect(nul[0]).toMatchObject({ title: "Supply of pipes", reference_number: "NUL-1", issuing_organisation: "Water Department" });
    expect(nul[0].documents[0].name).toBe("spec.pdf");
    const { rows: untitled } = await pool.query(`select title from public.tenders where organisation_id = $1 and source_ref = '960902'`, [scoutOrg]);
    expect(untitled[0].title).toBe("eTenders 960902");

    const { rows: done } = await pool.query(
      `select payload from public.agent_events where organisation_id = $1 and event_type = 'DISCOVERY_COMPLETED' order by created_at desc limit 1`,
      [scoutOrg],
    );
    expect(done[0].payload).toMatchObject({ rows_seen: 38, rows_skipped: 6 });
  });

  it("fails the scan, saying why, when most of the feed cannot be read, instead of completing with nothing", async () => {
    const before = await tenderCount();
    const drifted = Array.from({ length: 10 }, (_, i) => etendersRow({ id: { moved: i } }));
    const run = await scan(drifted);
    expect(run).toMatchObject({ status: "FAILED", rows_seen: 10, rows_skipped: 10, matched: 0, created_tenders: 0 });
    expect(run.error).toMatch(/10 rows and 10 \(100%\) could not be read/);
    expect(run.error).toMatch(/more than the 20% allowed/);
    expect(run.error).toMatch(/Nothing was stored/);
    expect(await tenderCount()).toBe(before);
    const { rows: note } = await pool.query(
      `select 1 from public.notifications where organisation_id = $1 and kind = 'DISCOVERY_FAILED' and body like '%could not be read%'`,
      [scoutOrg],
    );
    expect(note.length).toBeGreaterThan(0);
  });

  it("lets an operator choose how much unreadable data to tolerate", async () => {
    const mixed = () => [...good(7), ...Array.from({ length: 3 }, (_, i) => etendersRow({ id: { moved: i } }))];
    expect((await scan(mixed())).status).toBe("FAILED"); // 30 percent against the 20 percent default
    expect(await scan(mixed(), 0.5)).toMatchObject({ status: "COMPLETED", rows_seen: 10, rows_skipped: 3 });
    expect((await scan(mixed(), 0)).status).toBe("FAILED");
  });

  describe("a tender the database refuses", () => {
    beforeAll(async () => {
      await pool.query(`
        create or replace function public.test_refuse_tender() returns trigger language plpgsql as $$
        begin
          if new.reference_number like 'REFUSE-%' then raise exception 'refused by the test' using errcode = '23514'; end if;
          return new;
        end $$`);
      await pool.query(`drop trigger if exists test_refuse_tender on public.tenders`);
      await pool.query(`create trigger test_refuse_tender before insert on public.tenders for each row execute function public.test_refuse_tender()`);
    });
    afterAll(async () => {
      await pool.query(`drop trigger if exists test_refuse_tender on public.tenders`);
      await pool.query(`drop function if exists public.test_refuse_tender()`);
    });

    it("does not roll back the others: that row is skipped and counted, the rest are stored", async () => {
      const feed = [...good(30), etendersRow({ id: 960950, tender_No: "REFUSE-1", province: "Gauteng" })];
      const run = await scan(feed);
      expect(run).toMatchObject({ status: "COMPLETED", rows_seen: 31, rows_skipped: 1, matched: 31, created_tenders: 30 });
      const { rows } = await pool.query(`select reference_number from public.tenders where organisation_id = $1 and reference_number like 'REFUSE-%'`, [
        scoutOrg,
      ]);
      expect(rows).toEqual([]);
    });

    it("fails the scan when the database refuses most of what it was given", async () => {
      const feed = Array.from({ length: 10 }, (_, i) => etendersRow({ id: 961000 + i, tender_No: `REFUSE-${i}`, province: "Gauteng" }));
      const run = await scan(feed);
      expect(run).toMatchObject({ status: "FAILED", rows_seen: 10, rows_skipped: 10, created_tenders: 0 });
      expect(run.error).toMatch(/could not be stored/);
      expect(run.error).toMatch(/23514/);
    });
  });
});
