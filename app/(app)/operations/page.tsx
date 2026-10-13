import Link from "next/link";
import type { Metadata } from "next";
import { ActivityFeed } from "@/components/command-centre/activity-feed";
import { PageHeader } from "@/components/command-centre/page-header";
import { ApprovalStatusBadge, RunStatusBadge, TenderStatusBadge } from "@/components/command-centre/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WorkflowGraph } from "@/features/operations/workflow-graph";
import { ProblemsPanel } from "@/features/operations/problems-panel";
import { HandoffList } from "@/features/operations/handoff-list";
import { LiveRefresh } from "@/features/realtime/live-refresh";
import { canOperate, requireContext } from "@/lib/data/context";
import {
  getAgentFloor,
  getDashboardData,
  getPendingApprovals,
  getQueueHealth,
  getRecentEvents,
  getRecentHandoffs,
  getTenderTitles,
  getWorkerHealth,
} from "@/lib/data/queries";
import { relativeTime } from "@/lib/format";
import { stageCounts } from "@/lib/domain/tender-state";

export const metadata: Metadata = { title: "Operations" };

const STAGES = [
  ["new", "New"],
  ["qualifying", "Qualifying"],
  ["preparing", "Preparing"],
  ["approval", "Approval & submission"],
  ["submitted", "Submitted"],
  ["won", "Won"],
  ["lost", "Lost"],
  ["closed", "Closed"],
] as const;

export default async function OperationsPage() {
  const ctx = await requireContext();
  const orgId = ctx.organisation.id;
  const [floor, approvals, events, handoffs, health, worker, dash] = await Promise.all([
    getAgentFloor(orgId),
    getPendingApprovals(orgId),
    getRecentEvents(orgId, { limit: 60 }),
    getRecentHandoffs(orgId, 20),
    getQueueHealth(orgId),
    getWorkerHealth(),
    getDashboardData(orgId),
  ]);
  const agentNames = Object.fromEntries(floor.agents.map((a) => [a.id, a.display_name]));
  const tenderTitles = await getTenderTitles([...events.map((e) => e.tender_id), ...handoffs.map((h) => h.tender_id)]);
  // Counted by the database (dashboard_counts); reading a row per tender stopped at the API's 1000 rows.
  const stages = stageCounts(dash.tenders.byStatus);
  const errors = events.filter((e) => e.severity === "ERROR" || e.severity === "CRITICAL").slice(0, 8);

  return (
    <>
      <LiveRefresh tables={["approvals", "workflow_runs", "tenders"]} debounceMs={800} />
      <PageHeader title="Operations" description="Workflow graph, event stream and everything that needs attention." />

      <section aria-label="System health" className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Health
          label="Agent worker"
          ok={worker.online}
          value={worker.online ? `Online (${worker.workers})` : "Offline"}
          hint={worker.lastSeen ? `Heartbeat ${relativeTime(worker.lastSeen)}` : "No heartbeat yet"}
        />
        <Health label="Kill switch" ok={!ctx.settings.kill_switch} value={ctx.settings.kill_switch ? "Engaged" : "Released"} />
        <Health label="Blocked workflows" ok={health.blockedRuns.length === 0} value={String(health.blockedRuns.length)} />
        <Health label="Pending approvals" ok={approvals.length === 0} value={String(approvals.length)} warnOnly />
      </section>

      <WorkflowGraph initial={floor} approvals={approvals} />

      <section aria-label="Tender pipeline" className="mt-4 flex gap-2 overflow-x-auto">
        {STAGES.map(([k, label]) => (
          <Link key={k} href={`/tenders?stage=${k}`} className="min-w-28 flex-1 rounded-lg border bg-card p-2.5 hover:border-primary/40">
            <p className="text-[11px] text-muted-foreground">{label}</p>
            <p className="text-lg font-semibold tabular-nums">{stages[k]}</p>
          </Link>
        ))}
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-3 [&>*]:min-w-0">
        <Card className="xl:col-span-1">
          <CardHeader>
            <CardTitle>Event stream</CardTitle>
          </CardHeader>
          <CardContent className="max-h-[560px] overflow-y-auto">
            <ActivityFeed initial={events} agentNames={agentNames} tenderTitles={tenderTitles} limit={60} compact />
          </CardContent>
        </Card>
        <div className="grid grid-cols-1 content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Needs attention</CardTitle>
            </CardHeader>
            <CardContent>
              <ProblemsPanel initial={health.problemTasks} agentNames={agentNames} canRetry={canOperate(ctx.role)} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Human approvals</CardTitle>
            </CardHeader>
            <CardContent>
              {approvals.length === 0 ? (
                <p className="text-sm text-muted-foreground">No approvals pending.</p>
              ) : (
                <ul className="grid grid-cols-1 gap-2">
                  {approvals.map((a) => (
                    <li key={a.id}>
                      <Link href="/approvals" className="block rounded-lg border border-violet-500/40 p-2.5 hover:bg-violet-500/10">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm">{a.summary}</p>
                          <ApprovalStatusBadge status={a.status} />
                        </div>
                        <p className="text-[11px] text-muted-foreground">Requested {relativeTime(a.requested_at)}</p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>System errors</CardTitle>
            </CardHeader>
            <CardContent>
              {errors.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recent errors.</p>
              ) : (
                <ul className="grid grid-cols-1 gap-1.5 text-[12px]">
                  {errors.map((e) => (
                    <li key={e.id} className="rounded-md border border-red-500/30 bg-red-500/5 p-2">
                      <p className="text-red-200">{e.summary}</p>
                      <p className="text-[11px] text-muted-foreground">{relativeTime(e.created_at)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="grid grid-cols-1 content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Recent handoffs</CardTitle>
            </CardHeader>
            <CardContent>
              <HandoffList initial={handoffs} agentNames={agentNames} tenderTitles={tenderTitles} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Active workflows</CardTitle>
            </CardHeader>
            <CardContent>
              {dash.runs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No workflows running.</p>
              ) : (
                <ul className="grid grid-cols-1 gap-2">
                  {dash.runs.map((r) => (
                    <li key={r.id}>
                      <Link
                        href={`/tenders/${r.tender_id}`}
                        className="flex items-center justify-between gap-2 rounded-lg border p-2.5 hover:border-primary/40"
                      >
                        <span className="truncate text-sm">{(r.tenders as { title: string } | null)?.title}</span>
                        <RunStatusBadge status={r.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Deadline risks</CardTitle>
            </CardHeader>
            <CardContent>
              {dash.upcoming.filter((t) => new Date(t.closing_at).getTime() - Date.now() < 7 * 86_400_000).length === 0 ? (
                <p className="text-sm text-muted-foreground">No open tenders close within 7 days.</p>
              ) : (
                <ul className="grid grid-cols-1 gap-2">
                  {dash.upcoming
                    .filter((t) => new Date(t.closing_at).getTime() - Date.now() < 7 * 86_400_000)
                    .map((t) => (
                      <li key={t.id}>
                        <Link
                          href={`/tenders/${t.id}`}
                          className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 p-2.5 hover:bg-amber-500/5"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm">{t.title}</span>
                            <span className="text-[11px] text-amber-300">Closes {relativeTime(t.closing_at)}</span>
                          </span>
                          <TenderStatusBadge status={t.status} />
                        </Link>
                      </li>
                    ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function Health({ label, ok, value, hint, warnOnly }: { label: string; ok: boolean; value: string; hint?: string; warnOnly?: boolean }) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 flex items-center gap-1.5 text-sm font-medium">
        <span className={`size-2 rounded-full ${ok ? "bg-emerald-400" : warnOnly ? "bg-violet-400" : "bg-red-400"}`} aria-hidden />
        {value}
      </p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
