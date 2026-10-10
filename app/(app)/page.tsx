import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Plus } from "lucide-react";
import { ActivityFeed } from "@/components/command-centre/activity-feed";
import { PageHeader } from "@/components/command-centre/page-header";
import { StatTile } from "@/components/command-centre/stat-tile";
import { RunStatusBadge, SimulationBadge, TenderStatusBadge } from "@/components/command-centre/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LiveRefresh } from "@/features/realtime/live-refresh";
import { canOperate, requireContext } from "@/lib/data/context";
import { getAgentFloor, getDashboardData, getPendingApprovals, getRecentEvents, getTenderTitles } from "@/lib/data/queries";
import { formatDateTime, formatUsd, humanize, relativeTime } from "@/lib/format";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const ctx = await requireContext();
  const orgId = ctx.organisation.id;
  const [d, events, floor, approvals] = await Promise.all([
    getDashboardData(orgId),
    getRecentEvents(orgId, { limit: 40 }),
    getAgentFloor(orgId),
    getPendingApprovals(orgId),
  ]);
  const agentNames = Object.fromEntries(floor.agents.map((a) => [a.id, a.display_name]));
  const tenderTitles = await getTenderTitles(events.map((e) => e.tender_id));
  const budget = ctx.settings;

  return (
    <>
      <LiveRefresh tables={["tenders", "agents", "approvals", "workflow_runs"]} debounceMs={800} />
      <PageHeader
        title="Command centre"
        description="Live state of your tender department."
        actions={
          canOperate(ctx.role) && (
            <Button asChild size="sm">
              <Link href="/tenders/new">
                <Plus /> New tender
              </Link>
            </Button>
          )
        }
      />

      {approvals.length > 0 && (
        <Link
          href="/approvals"
          className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-violet-500/40 bg-violet-500/10 px-4 py-3 text-sm hover:bg-violet-500/15"
        >
          <span>
            <strong className="font-semibold text-violet-200">
              {approvals.length} approval{approvals.length > 1 ? "s" : ""} waiting.
            </strong>{" "}
            <span className="text-violet-200/80">Agents are paused at a human decision.</span>
          </span>
          <ArrowRight className="size-4 text-violet-200" aria-hidden />
        </Link>
      )}

      <section aria-label="Tender pipeline" className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <StatTile label="Active tenders" value={d.tenders.active} href="/tenders" />
        <StatTile label="New" value={d.tenders.new} href="/tenders?stage=new" />
        <StatTile label="Qualified" value={d.tenders.qualified} />
        <StatTile label="In preparation" value={d.tenders.preparing} />
        <StatTile label="Awaiting approval" value={d.tenders.awaitingApproval} tone={d.tenders.awaitingApproval ? "violet" : undefined} href="/approvals" />
        <StatTile label="Submitted" value={d.tenders.submitted} />
        <StatTile label="Won" value={d.tenders.won} tone={d.tenders.won ? "emerald" : undefined} />
        <StatTile label="Unsuccessful" value={d.tenders.lost} />
      </section>

      <section aria-label="Agents and spend" className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Agents working" value={d.agents.active} hint={`of ${d.agents.total}`} href="/office" />
        <StatTile label="Agents idle" value={d.agents.idle} href="/office" />
        <StatTile label="Agents failed" value={d.agents.failed} tone={d.agents.failed ? "red" : undefined} href="/operations" />
        <StatTile label="Blocked or paused" value={d.agents.blocked} tone={d.agents.blocked ? "amber" : undefined} href="/operations" />
        <StatTile label="AI spend today" value={formatUsd(d.spend.today)} hint={`Budget ${formatUsd(Number(budget.daily_ai_budget_usd))}`} />
        <StatTile label="AI spend this month" value={formatUsd(d.spend.month)} hint={`Budget ${formatUsd(Number(budget.monthly_ai_budget_usd))}`} />
      </section>

      <div className="mt-5 grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
        <div className="grid grid-cols-1 gap-4 lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle>Active workflows</CardTitle>
            </CardHeader>
            <CardContent>
              {d.runs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No workflows running.</p>
              ) : (
                <ul className="grid grid-cols-1 gap-2">
                  {d.runs.map((r) => (
                    <li key={r.id}>
                      <Link href={`/tenders/${r.tender_id}`} className="block rounded-lg border p-2.5 hover:border-primary/40">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm">{(r.tenders as { title: string } | null)?.title ?? "Tender"}</p>
                          <RunStatusBadge status={r.status} />
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Step: {humanize(r.current_step)} {r.is_simulation && "· simulation"}
                        </p>
                        {r.error && <p className="mt-1 line-clamp-2 text-[11px] text-red-300">{r.error}</p>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Upcoming deadlines</CardTitle>
            </CardHeader>
            <CardContent>
              {d.upcoming.length === 0 ? (
                <p className="text-sm text-muted-foreground">No open tenders close in the next 14 days.</p>
              ) : (
                <ul className="grid grid-cols-1 gap-2">
                  {d.upcoming.map((t) => (
                    <li key={t.id}>
                      <Link href={`/tenders/${t.id}`} className="flex items-center justify-between gap-2 rounded-lg border p-2.5 hover:border-primary/40">
                        <div className="min-w-0">
                          <p className="truncate text-sm">{t.title}</p>
                          <p className="text-[11px] text-muted-foreground" title={formatDateTime(t.closing_at)}>
                            Closes {relativeTime(t.closing_at)}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <TenderStatusBadge status={t.status} />
                          {t.is_simulation && <SimulationBadge />}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Live activity</CardTitle>
            <Link href="/activity" className="text-xs text-primary hover:underline">
              Full history
            </Link>
          </CardHeader>
          <CardContent className="max-h-[640px] overflow-y-auto">
            <ActivityFeed initial={events} agentNames={agentNames} tenderTitles={tenderTitles} limit={40} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
