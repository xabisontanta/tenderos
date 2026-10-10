import type { Pool } from "@/lib/db/pool";
import { withTx } from "@/lib/db/pool";
import type { Logger } from "@/lib/log";
import { formatSast, provinceLabel } from "@/lib/format";
import { fetchOpenTenders, mapEtendersRow, type DiscoveredTender, type Fetcher } from "@/agents/discovery/etenders";
import { MIN_PREPARATION_HOURS } from "@/agents/qualification/logic";
import type { JobOutcome } from "./engine";
import * as db from "./store";

export interface DiscoveryDeps {
  fetcher: Fetcher;
  logger: Logger;
  now: () => Date;
}

const MAX_EVENTS_PER_SCAN = 40;
const MAX_FETCH_ATTEMPTS = 3;

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

  // 1. Read the portal.
  const found: DiscoveredTender[] = [];
  let scanned = 0;
  try {
    for await (const page of fetchOpenTenders(deps.fetcher)) {
      scanned += page.rows.length;
      for (const row of page.rows) {
        const m = mapEtendersRow(row, deps.now());
        if (m.ok && wanted.has(m.tender.province) && methods.has(m.tender.submission_method)) found.push(m.tender);
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

  // 2. Store what is new and report it.
  const result = await withTx(
    pool,
    async (c) => {
      let created = 0;
      let refreshed = 0;
      const createdIds: string[] = [];
      // Tenders already on file: the same portal row (refresh it) or the same
      // reference number entered another way (leave it alone).
      const { rows: existing } = await c.query<{
        id: string;
        source_id: string | null;
        source_ref: string | null;
        reference_number: string | null;
        closing_at: string;
        status: string;
      }>(
        `select id, source_id, source_ref, reference_number, closing_at, status from public.tenders
          where organisation_id = $1 and ((source_id = $2 and source_ref = any ($3)) or reference_number = any ($4))`,
        [run.organisation_id, sourceId, found.map((t) => t.source_ref), found.flatMap((t) => (t.reference_number ? [t.reference_number] : []))],
      );
      const bySourceRef = new Map(existing.filter((e) => e.source_id === sourceId && e.source_ref).map((e) => [e.source_ref!, e]));
      const byReference = new Map(existing.filter((e) => e.reference_number).map((e) => [e.reference_number!, e]));
      for (const t of found) {
        const prev = bySourceRef.get(t.source_ref);
        if (prev) {
          if (!FROZEN_STATUSES.has(prev.status) && (await refreshTender(c, prev, t, scout.id, taskId))) refreshed++;
          continue;
        }
        if (t.reference_number && byReference.has(t.reference_number)) continue;
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
        if (!rows[0]) continue;
        created++;
        createdIds.push(rows[0].id);
        if (created <= MAX_EVENTS_PER_SCAN) {
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
      }
      await c.query(`update public.tasks set status = 'COMPLETED', progress = 100, completed_at = now(), progress_message = $2, output = $3 where id = $1`, [
        taskId,
        `${found.length} open tenders in scope, ${created} new${refreshed ? `, ${refreshed} updated` : ""}`,
        JSON.stringify({ scanned, matched: found.length, created, refreshed, provinces: run.provinces, source: "etenders" }),
      ]);
      await c.query(`update public.discovery_runs set scanned = $2, matched = $3, created_tenders = $4 where id = $1`, [
        run.id,
        scanned,
        found.length,
        created,
      ]);
      await c.query("update public.system_settings set last_discovery_at = now() where organisation_id = $1", [run.organisation_id]);
      const summary = `${scout.display_name} scanned ${scanned} published tenders: ${found.length} in ${run.provinces.map(provinceLabel).join(", ")}, ${created} new`;
      await db.emitEvent(c, { organisationId: run.organisation_id, type: "AGENT_COMPLETED_TASK", summary, agentId: scout.id, taskId });
      await db.setAgentActivity(c, scout.id, summary, null);
      await db.refreshAgent(c, scout.id);
      return { created, createdIds };
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
      summary: `Scan finished: ${found.length} open tenders in scope, ${result.created} new` + (started ? `, ${started} handed to the Tender Director` : ""),
      agentId: scout.id,
      taskId,
      payload: { discovery_run_id: run.id, scanned, matched: found.length, created: result.created, started_workflows: started },
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

async function failScan(pool: Pool, run: RunRow, scout: { id: string; display_name: string }, taskId: string, message: string) {
  await withTx(pool, async (c) => {
    await c.query("update public.tasks set status = 'FAILED', failed_at = now(), error = $2 where id = $1", [taskId, message.slice(0, 2000)]);
    await c.query("update public.discovery_runs set status = 'FAILED', completed_at = now(), error = $2 where id = $1", [run.id, message.slice(0, 2000)]);
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
async function refreshTender(
  c: Parameters<Parameters<typeof withTx>[1]>[0],
  prev: { id: string; closing_at: string },
  t: DiscoveredTender,
  scoutId: string,
  taskId: string,
): Promise<boolean> {
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
