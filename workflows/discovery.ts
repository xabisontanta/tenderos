import type { Pool } from "@/lib/db/pool";
import { withTx } from "@/lib/db/pool";
import type { Logger } from "@/lib/log";
import { formatSast, provinceLabel } from "@/lib/format";
import { feedHealth, fetchOpenTenders, mapEtendersRow, type DiscoveredTender, type FeedStats, type Fetcher } from "@/agents/discovery/etenders";
import { MIN_PREPARATION_HOURS } from "@/agents/qualification/logic";
import type { JobOutcome } from "./engine";
import * as db from "./store";

export interface DiscoveryDeps {
  fetcher: Fetcher;
  logger: Logger;
  now: () => Date;
  /** Share of the portal's rows that may be unreadable before the scan fails (default 0.2). */
  maxInvalidRatio?: number;
}

const MAX_EVENTS_PER_SCAN = 40;
const MAX_FETCH_ATTEMPTS = 3;
/** Tenders stored per transaction: a long scan does not hold one transaction (and its locks) open, and work already committed survives a later failure. */
const STORE_CHUNK = 200;
const DEFAULT_MAX_INVALID_RATIO = 0.2;

type Tx = Parameters<Parameters<typeof withTx>[1]>[0];

interface RunRow {
  id: string;
  organisation_id: string;
  provinces: string[];
  methods: string[];
  status: string;
}

/**
 * The Tender Scout's scan. Reads every published tender from eTenders, keeps
 * those in the requested provinces, stores new ones, and (when the
 * organisation allows it) starts the bid workflow on each so the other agents
 * take over without anyone pressing a button.
 */
export async function runDiscovery(pool: Pool, runId: string, attempts: number, deps: DiscoveryDeps): Promise<JobOutcome> {
  const setup = await withTx(pool, async (c) => {
    const { rows } = await c.query<RunRow>("select id, organisation_id, provinces, methods, status from public.discovery_runs where id = $1 for update", [
      runId,
    ]);
    const run = rows[0];
    if (!run || (run.status !== "QUEUED" && run.status !== "RUNNING")) return null;
    const scout = await db.getAgentBySlug(c, run.organisation_id, "tender_discovery");
    const { rows: src } = await c.query<{ id: string }>("select id from public.tender_sources where organisation_id = $1 and slug = 'etenders'", [
      run.organisation_id,
    ]);
    if (!src[0]) throw new Error("eTenders source missing for organisation");
    await c.query("update public.discovery_runs set status = 'RUNNING', started_at = coalesce(started_at, now()), error = null where id = $1", [run.id]);
    const names = run.provinces.map(provinceLabel).join(", ");
    const { rows: task } = await c.query<{ id: string }>(
      `insert into public.tasks (organisation_id, agent_id, type, title, description, status, priority, input, idempotency_key, started_at, progress_message)
       values ($1, $2, 'discovery.scan', $3, 'Reading published tenders from National Treasury eTenders', 'RUNNING', 7, $4, $5, now(), 'Connecting to eTenders')
       on conflict (organisation_id, idempotency_key) where idempotency_key is not null
       do update set status = 'RUNNING', error = null, progress = 0
       returning id`,
      [run.organisation_id, scout.id, `Scan eTenders: ${names}`.slice(0, 200), JSON.stringify({ provinces: run.provinces }), `discovery:${run.id}`],
    );
    await db.emitEvent(c, {
      organisationId: run.organisation_id,
      type: "DISCOVERY_STARTED",
      summary: `${scout.display_name} is scanning eTenders for ${names}`,
      agentId: scout.id,
      taskId: task[0].id,
      payload: { discovery_run_id: run.id, provinces: run.provinces },
    });
    await db.emitEvent(c, {
      organisationId: run.organisation_id,
      type: "AGENT_STARTED_TASK",
      summary: `${scout.display_name} started: scan eTenders for ${names}`,
      agentId: scout.id,
      taskId: task[0].id,
    });
    await db.setAgentActivity(c, scout.id, `Scanning eTenders for ${names}`, "Hand new tenders to the Tender Director");
    await db.refreshAgent(c, scout.id);
    return { run, scout, sourceId: src[0].id, taskId: task[0].id };
  });
  if (!setup) return { status: "completed" };
  const { run, scout, sourceId, taskId } = setup;
  const log = deps.logger.child({ discovery_run_id: run.id });
  const wanted = new Set(run.provinces);
  const methods = new Set(run.methods);

  // 1. Read the portal. Rows that cannot be used are counted, with the reason, never dropped silently.
  const found: DiscoveredTender[] = [];
  const stats: FeedStats = { seen: 0, unreadable: 0, reasons: {} };
  const count = (why: string, n = 1) => void (stats.reasons[why] = (stats.reasons[why] ?? 0) + n);
  let scanned = 0;
  try {
    for await (const page of fetchOpenTenders(deps.fetcher)) {
      scanned += page.rows.length;
      stats.seen += page.seen;
      stats.unreadable += page.unreadable;
      for (const [why, n] of Object.entries(page.reasons)) count(why, n);
      for (const row of page.rows) {
        const m = mapEtendersRow(row, deps.now());
        if (!m.ok) {
          // A tender that has closed is normal; one without a closing date or an issuing organisation is malformed.
          if (m.reason !== "already closed") {
            stats.unreadable++;
            count(m.reason);
          }
          continue;
        }
        if (wanted.has(m.tender.province) && methods.has(m.tender.submission_method)) found.push(m.tender);
      }
      const pct = page.total ? Math.min(90, Math.round((scanned / page.total) * 90)) : 50;
      await pool.query("update public.tasks set progress = $2, progress_message = $3 where id = $1", [
        taskId,
        pct,
        `Read ${scanned} of ${page.total} published tenders; ${found.length} in scope`,
      ]);
    }
  } catch (err) {
    const message = (err as Error).message;
    log.warn("etenders fetch failed", { error: message, attempts });
    if (attempts < MAX_FETCH_ATTEMPTS) {
      await pool.query("update public.tasks set progress_message = $2 where id = $1", [taskId, `eTenders unavailable, retrying: ${message}`.slice(0, 200)]);
      return { status: "retry", runAt: new Date(deps.now().getTime() + 60_000 * attempts), error: message };
    }
    await failScan(pool, run, scout, taskId, `Could not read eTenders: ${message}`);
    return { status: "completed" };
  }

  // A feed we could barely read is a failed scan, not "completed, 0 matched".
  const maxInvalid = deps.maxInvalidRatio ?? DEFAULT_MAX_INVALID_RATIO;
  if (stats.unreadable > 0) log.warn("eTenders rows could not be used", { seen: stats.seen, unreadable: stats.unreadable, reasons: stats.reasons });
  const feed = feedHealth(stats, maxInvalid);
  if (!feed.ok) {
    await failScan(pool, run, scout, taskId, `${feed.message} Nothing was stored.`, { seen: stats.seen, skipped: stats.unreadable, scanned });
    return { status: "completed" };
  }

  // 2. Store what is new, a chunk of tenders per transaction and a savepoint per tender, so one row the database
  //    refuses is skipped and counted instead of undoing the others.
  const stored = await storeTenders(pool, run, sourceId, scout, taskId, found, log);
  const skipped = stats.unreadable + stored.failed;
  const storeHealth = found.length > 0 && stored.failed / found.length > maxInvalid + 1e-9;
  if (storeHealth) {
    const why = Object.entries(stored.reasons)
      .map(([reason, n]) => `${n} × ${reason}`)
      .join(", ");
    await failScan(
      pool,
      run,
      scout,
      taskId,
      `${stored.failed} of ${found.length} tenders could not be stored (${why}), more than the ${Math.round(maxInvalid * 100)}% allowed. ${stored.created} were stored.`,
      { seen: stats.seen, skipped, scanned },
    );
    return { status: "completed" };
  }

  const result = await withTx(
    pool,
    async (c) => {
      const { created, refreshed } = stored;
      await c.query(`update public.tasks set status = 'COMPLETED', progress = 100, completed_at = now(), progress_message = $2, output = $3 where id = $1`, [
        taskId,
        `${found.length} open tenders in scope, ${created} new${refreshed ? `, ${refreshed} updated` : ""}${skipped ? `, ${skipped} rows skipped` : ""}`,
        JSON.stringify({
          scanned,
          matched: found.length,
          created,
          refreshed,
          rows_seen: stats.seen,
          rows_skipped: skipped,
          skip_reasons: { ...stats.reasons, ...stored.reasons },
          provinces: run.provinces,
          source: "etenders",
        }),
      ]);
      await c.query(`update public.discovery_runs set scanned = $2, matched = $3, created_tenders = $4, rows_seen = $5, rows_skipped = $6 where id = $1`, [
        run.id,
        scanned,
        found.length,
        created,
        stats.seen,
        skipped,
      ]);
      await c.query("update public.system_settings set last_discovery_at = now() where organisation_id = $1", [run.organisation_id]);
      const summary = `${scout.display_name} scanned ${scanned} published tenders: ${found.length} in ${run.provinces.map(provinceLabel).join(", ")}, ${created} new${skipped ? `, ${skipped} rows skipped` : ""}`;
      await db.emitEvent(c, { organisationId: run.organisation_id, type: "AGENT_COMPLETED_TASK", summary, agentId: scout.id, taskId });
      await db.setAgentActivity(c, scout.id, summary, null);
      await db.refreshAgent(c, scout.id);
      return { created };
    },
    scout.id,
  );

  // 3. Hand tenders to the agents. Each start is its own transaction so one
  //    refusal (for example the kill switch) does not undo the others.
  const started = await autoStartWorkflows(pool, run, log);

  await withTx(pool, async (c) => {
    await c.query(`update public.discovery_runs set status = 'COMPLETED', completed_at = now(), started_workflows = $2 where id = $1`, [run.id, started]);
    await db.emitEvent(c, {
      organisationId: run.organisation_id,
      type: "DISCOVERY_COMPLETED",
      summary:
        `Scan finished: ${found.length} open tenders in scope, ${result.created} new` +
        (started ? `, ${started} handed to the Tender Director` : "") +
        (skipped ? `, ${skipped} of ${stats.seen} rows could not be used` : ""),
      agentId: scout.id,
      taskId,
      payload: {
        discovery_run_id: run.id,
        scanned,
        matched: found.length,
        created: result.created,
        started_workflows: started,
        rows_seen: stats.seen,
        rows_skipped: skipped,
      },
    });
    if (result.created > 0) {
      await db.notifyMembers(
        c,
        run.organisation_id,
        "TENDERS_DISCOVERED",
        "INFO",
        `${result.created} new tenders found`,
        `${run.provinces.map(provinceLabel).join(", ")}: ${result.created} new, ${started} being prepared by the agents`,
        "/discover",
      );
    }
  });
  log.info("discovery completed", { scanned, matched: found.length, created: result.created, started });
  return { status: "completed" };
}

interface StoreResult {
  created: number;
  refreshed: number;
  /** Tenders the database refused. */
  failed: number;
  /** Why, as text → how many (an error code, never a value from the row). */
  reasons: Record<string, number>;
}

/**
 * Stores the tenders a scan found. STORE_CHUNK tenders share a transaction; each has its own savepoint, so a row
 * the database refuses (a check, a trigger, a bad byte) is rolled back alone, counted, and the rest carry on.
 */
async function storeTenders(
  pool: Pool,
  run: RunRow,
  sourceId: string,
  scout: { id: string; display_name: string },
  taskId: string,
  found: DiscoveredTender[],
  log: Logger,
): Promise<StoreResult> {
  const out: StoreResult = { created: 0, refreshed: 0, failed: 0, reasons: {} };
  for (let i = 0; i < found.length; i += STORE_CHUNK) {
    const chunk = found.slice(i, i + STORE_CHUNK);
    await withTx(
      pool,
      async (c) => {
        // Tenders already on file: the same portal row (refresh it) or the same
        // reference number entered another way (leave it alone).
        const { rows: existing } = await c.query<ExistingTender>(
          `select id, source_id, source_ref, reference_number, closing_at, status from public.tenders
            where organisation_id = $1 and ((source_id = $2 and source_ref = any ($3)) or reference_number = any ($4))`,
          [run.organisation_id, sourceId, chunk.map((t) => t.source_ref), chunk.flatMap((t) => (t.reference_number ? [t.reference_number] : []))],
        );
        const known = {
          bySourceRef: new Map(existing.filter((e) => e.source_id === sourceId && e.source_ref).map((e) => [e.source_ref!, e])),
          byReference: new Map(existing.filter((e) => e.reference_number).map((e) => [e.reference_number!, e])),
        };
        for (const t of chunk) {
          await c.query("savepoint scan_row");
          try {
            const outcome = await storeOne(c, run, sourceId, scout, taskId, t, known, out.created < MAX_EVENTS_PER_SCAN);
            await c.query("release savepoint scan_row");
            if (outcome === "created") out.created++;
            else if (outcome === "refreshed") out.refreshed++;
          } catch (err) {
            await c.query("rollback to savepoint scan_row");
            const { code, constraint } = err as { code?: string; constraint?: string };
            const why = `database error ${code ?? "unknown"}${constraint ? ` on ${constraint}` : ""}`;
            out.failed++;
            out.reasons[why] = (out.reasons[why] ?? 0) + 1;
            log.warn("tender not stored", { source_ref: t.source_ref, code, constraint });
          }
        }
      },
      scout.id,
    );
  }
  return out;
}

interface ExistingTender {
  id: string;
  source_id: string | null;
  source_ref: string | null;
  reference_number: string | null;
  closing_at: string;
  status: string;
}

async function storeOne(
  c: Tx,
  run: RunRow,
  sourceId: string,
  scout: { id: string; display_name: string },
  taskId: string,
  t: DiscoveredTender,
  known: { bySourceRef: Map<string, ExistingTender>; byReference: Map<string, ExistingTender> },
  announce: boolean,
): Promise<"created" | "refreshed" | "unchanged"> {
  const prev = known.bySourceRef.get(t.source_ref);
  if (prev) {
    return !FROZEN_STATUSES.has(prev.status) && (await refreshTender(c, prev, t, scout.id, taskId)) ? "refreshed" : "unchanged";
  }
  if (t.reference_number && known.byReference.has(t.reference_number)) return "unchanged";
  const { rows } = await c.query<{ id: string }>(
    `insert into public.tenders (organisation_id, source_id, source_ref, reference_number, title, issuing_organisation, description,
       province, sector, published_at, closing_at, briefing_at, briefing_compulsory, briefing_location, submission_method,
       submission_destination, source_url, documents, is_simulation)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,false)
     on conflict do nothing returning id`,
    [
      run.organisation_id,
      sourceId,
      t.source_ref,
      t.reference_number,
      t.title,
      t.issuing_organisation,
      t.description,
      t.province,
      t.sector,
      t.published_at,
      t.closing_at,
      t.briefing_at,
      t.briefing_compulsory,
      t.briefing_location,
      t.submission_method,
      t.submission_destination,
      t.source_url,
      JSON.stringify(t.documents),
    ],
  );
  if (!rows[0]) return "unchanged";
  await queueDocuments(c, rows[0].id);
  if (announce) {
    await db.emitEvent(c, {
      organisationId: run.organisation_id,
      type: "TENDER_DISCOVERED",
      summary: `${scout.display_name} found "${t.title.slice(0, 160)}" (${provinceLabel(t.province)}, closes ${formatSast(t.closing_at)})`,
      agentId: scout.id,
      tenderId: rows[0].id,
      taskId,
      payload: { source: "etenders", source_ref: t.source_ref, reference: t.reference_number, contact: t.contact },
    });
  }
  return "created";
}

/**
 * A tender that gained document links gets them listed and a fetch queued (private.queue_tender_documents). Only for
 * organisations that have AI assistance on: the files are of no use without it, and a scan can store hundreds of tenders.
 * A person can always press "Fetch documents" on the tender.
 */
async function queueDocuments(c: Tx, tenderId: string): Promise<void> {
  await c.query("select private.queue_tender_documents($1)", [tenderId]);
}

async function autoStartWorkflows(pool: Pool, run: RunRow, log: Logger): Promise<number> {
  const { rows: settings } = await pool.query<{ auto_run_workflows: boolean; max_auto_workflows_per_scan: number; kill_switch: boolean }>(
    "select auto_run_workflows, max_auto_workflows_per_scan, kill_switch from public.system_settings where organisation_id = $1",
    [run.organisation_id],
  );
  const s = settings[0];
  if (!s || !s.auto_run_workflows || s.kill_switch || s.max_auto_workflows_per_scan === 0) return 0;
  // Oldest backlog first among tenders that still leave enough time to bid.
  const { rows } = await pool.query<{ id: string }>(
    `select t.id from public.tenders t
      where t.organisation_id = $1 and t.status = 'DISCOVERED' and not t.is_simulation
        and t.province = any ($2) and t.submission_method::text = any ($5)
        and t.closing_at > now() + make_interval(hours => $3)
        and not exists (select 1 from public.workflow_runs r where r.tender_id = t.id)
      order by t.closing_at asc
      limit $4`,
    [run.organisation_id, run.provinces, MIN_PREPARATION_HOURS, s.max_auto_workflows_per_scan, run.methods],
  );
  let started = 0;
  for (const r of rows) {
    try {
      await pool.query("select private.create_workflow_run($1, 'tender_bid', '{}'::jsonb, null)", [r.id]);
      started++;
    } catch (err) {
      log.warn("auto start refused", { tender_id: r.id, error: (err as Error).message });
    }
  }
  return started;
}

/** Counts to keep on a failed scan: what the portal sent, what could not be used, what could be read. */
interface FailedCounts {
  seen: number;
  skipped: number;
  scanned: number;
}

async function failScan(pool: Pool, run: RunRow, scout: { id: string; display_name: string }, taskId: string, message: string, counts?: FailedCounts) {
  await withTx(pool, async (c) => {
    await c.query("update public.tasks set status = 'FAILED', failed_at = now(), error = $2 where id = $1", [taskId, message.slice(0, 2000)]);
    await c.query(
      "update public.discovery_runs set status = 'FAILED', completed_at = now(), error = $2, rows_seen = $3, rows_skipped = $4, scanned = $5 where id = $1",
      [run.id, message.slice(0, 2000), counts?.seen ?? 0, counts?.skipped ?? 0, counts?.scanned ?? 0],
    );
    await db.emitEvent(c, {
      organisationId: run.organisation_id,
      type: "DISCOVERY_FAILED",
      severity: "ERROR",
      summary: message.slice(0, 500),
      agentId: scout.id,
      taskId,
      payload: { discovery_run_id: run.id },
    });
    await db.emitEvent(c, {
      organisationId: run.organisation_id,
      type: "AGENT_FAILED_TASK",
      severity: "ERROR",
      summary: `${scout.display_name}: ${message}`.slice(0, 500),
      agentId: scout.id,
      taskId,
    });
    await db.setAgentActivity(c, scout.id, `Failed: ${message}`.slice(0, 300), "Retry at the next scan");
    await db.refreshAgent(c, scout.id);
    await db.notifyMembers(c, run.organisation_id, "DISCOVERY_FAILED", "ERROR", "Tender scan failed", message.slice(0, 2000), "/discover");
  });
}

/** Once a bid is in, the portal row no longer changes what the organisation must do. */
const FROZEN_STATUSES = new Set(["SUBMITTED", "UNDER_EVALUATION", "AWARDED", "UNSUCCESSFUL", "CANCELLED", "ARCHIVED"]);

/**
 * Brings a stored tender in line with the portal (closing date extensions,
 * briefing changes, new documents). A moved closing date also moves a pending
 * approval's expiry and is reported. Returns true when anything changed.
 */
async function refreshTender(c: Tx, prev: { id: string; closing_at: string }, portal: DiscoveredTender, scoutId: string, taskId: string): Promise<boolean> {
  // Once a bid is waiting for approval or delivery its delivery details are locked (migration 055): the
  // portal may move the closing date, but not the address, method or link the bid was approved with.
  const { rows: current } = await c.query<{
    organisation_id: string;
    locked: boolean;
    submission_method: DiscoveredTender["submission_method"];
    submission_destination: string | null;
    source_url: string | null;
  }>(
    `select organisation_id, private.delivery_locked(id, status) as locked, submission_method::text as submission_method, submission_destination, source_url
       from public.tenders where id = $1`,
    [prev.id],
  );
  const cur = current[0];
  if (!cur) return false;
  const deliveryChanged =
    portal.submission_method !== cur.submission_method || portal.submission_destination !== cur.submission_destination || portal.source_url !== cur.source_url;
  // What is written: the portal's values, except the delivery details of a locked bid (stored ones may be null).
  const t: Omit<DiscoveredTender, "source_url"> & { source_url: string | null } = cur.locked
    ? { ...portal, submission_method: cur.submission_method, submission_destination: cur.submission_destination, source_url: cur.source_url }
    : portal;
  if (cur.locked && deliveryChanged) await reportKeptDelivery(c, prev.id, cur.organisation_id, portal, scoutId, taskId);

  const { rows } = await c.query<{ organisation_id: string }>(
    `update public.tenders
        set description = $2::text, closing_at = $3::timestamptz, briefing_at = $4::timestamptz, briefing_compulsory = $5::boolean,
            briefing_location = $6::text, submission_method = $7::text::public.submission_method, submission_destination = $8::text,
            source_url = $9::text, documents = $10::jsonb
      where id = $1
        and (description, closing_at, briefing_at, briefing_compulsory, briefing_location, submission_method::text,
             submission_destination, source_url, documents)
            is distinct from ($2::text, $3::timestamptz, $4::timestamptz, $5::boolean, $6::text, $7::text, $8::text, $9::text, $10::jsonb)
      returning organisation_id`,
    [
      prev.id,
      t.description,
      t.closing_at,
      t.briefing_at,
      t.briefing_compulsory,
      t.briefing_location,
      t.submission_method,
      t.submission_destination,
      t.source_url,
      JSON.stringify(t.documents),
    ],
  );
  if (!rows[0]) return false;
  await queueDocuments(c, prev.id);
  if (new Date(prev.closing_at).getTime() !== new Date(t.closing_at).getTime()) {
    await c.query(`update public.approvals set expires_at = $2 where tender_id = $1 and status = 'PENDING'`, [prev.id, t.closing_at]);
    await db.emitEvent(c, {
      organisationId: rows[0].organisation_id,
      type: "TENDER_UPDATED",
      severity: "WARNING",
      summary: `Closing date changed on eTenders: now ${formatSast(t.closing_at)} (was ${formatSast(prev.closing_at)})`,
      agentId: scoutId,
      tenderId: prev.id,
      taskId,
      payload: { previous_closing_at: prev.closing_at, closing_at: t.closing_at },
    });
  }
  return true;
}

/**
 * The portal lists other delivery details than the ones a bid was put forward with. They are not applied,
 * so the person is told once for each distinct set of details the portal shows, not on every scan.
 */
async function reportKeptDelivery(c: Tx, tenderId: string, organisationId: string, portal: DiscoveredTender, scoutId: string, taskId: string): Promise<void> {
  const payload = {
    kept_delivery_details: true,
    portal: { submission_method: portal.submission_method, submission_destination: portal.submission_destination, source_url: portal.source_url },
  };
  const { rows } = await c.query(`select 1 from public.agent_events where tender_id = $1 and event_type = 'TENDER_UPDATED' and payload @> $2::jsonb limit 1`, [
    tenderId,
    JSON.stringify(payload),
  ]);
  if (rows.length) return;
  await db.emitEvent(c, {
    organisationId,
    type: "TENDER_UPDATED",
    severity: "WARNING",
    summary:
      "eTenders now lists different delivery details for this tender. The bid keeps the delivery details it was put forward with: check the portal before delivering, and use Change delivery details if they really changed.",
    agentId: scoutId,
    tenderId,
    taskId,
    payload,
  });
}
