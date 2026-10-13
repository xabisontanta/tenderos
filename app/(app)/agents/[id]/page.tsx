import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActivityFeed } from "@/components/command-centre/activity-feed";
import { AgentAvatar } from "@/components/command-centre/agent-avatar";
import { JsonView } from "@/components/command-centre/json-view";
import { AgentStatusBadge, TaskStatusBadge } from "@/components/command-centre/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { AgentControls } from "@/features/agents/agent-controls";
import { TaskRetryButton } from "@/features/agents/task-retry-button";
import { HandoffList } from "@/features/operations/handoff-list";
import { LiveRefresh } from "@/features/realtime/live-refresh";
import { canAdminister, canOperate, requireContext } from "@/lib/data/context";
import { getRecentEvents, getTenderTitles, rowOrThrow, rowsOrThrow } from "@/lib/data/queries";
import { getServerSupabase } from "@/lib/supabase/server";
import { formatDateTime, formatUsd, humanize, relativeTime } from "@/lib/format";
import { configuredModels, selectModel } from "@/agents/runtime/model-routing";
import { getAgentDefinition } from "@/agents/registry";

export const metadata: Metadata = { title: "Agent" };

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireContext();
  const supabase = await getServerSupabase();
  const { data: agent, error: agentError } = await supabase.from("agents").select("*, departments(name, accent)").eq("id", id).maybeSingle();
  if (agentError) throw new Error(`Could not load the agent: ${agentError.message}`);
  if (!agent) notFound();

  const [tasks, perms, transitions, handoffs, usage, events, allAgents, currentTask] = await Promise.all([
    supabase.from("tasks").select("*").eq("agent_id", id).order("created_at", { ascending: false }).limit(25),
    supabase.from("agent_permissions").select("data_category,access").eq("agent_id", id),
    supabase.from("agent_status_transitions").select("*").eq("agent_id", id).order("created_at", { ascending: false }).limit(20),
    supabase.from("handoffs").select("*").or(`from_agent_id.eq.${id},to_agent_id.eq.${id}`).order("created_at", { ascending: false }).limit(20),
    // Summed by the database: fetching the rows stopped at the API's 1000 and under-reported spend and tokens.
    supabase.rpc("agent_usage_totals", { p_agent_id: id }),
    getRecentEvents(ctx.organisation.id, { agentId: id, limit: 40 }),
    supabase.from("agents").select("id,display_name").eq("organisation_id", ctx.organisation.id),
    agent.current_task_id ? supabase.from("tasks").select("*").eq("id", agent.current_task_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  if (usage.error) throw new Error(`Could not load the agent's usage: ${usage.error.message}`);

  const dep = agent.departments as { name: string; accent: string } | null;
  const def = getAgentDefinition(agent.slug);
  const taskRows = rowsOrThrow(tasks, "the agent's tasks");
  const permRows = rowsOrThrow(perms, "the agent's permissions");
  const transitionRows = rowsOrThrow(transitions, "the agent's status history");
  const handoffRows = rowsOrThrow(handoffs, "the agent's handoffs");
  const agentRows = rowsOrThrow(allAgents, "agents");
  const completed = taskRows.filter((t) => t.status === "COMPLETED");
  const failed = taskRows.filter((t) => t.status === "FAILED");
  const durations = completed.filter((t) => t.started_at && t.completed_at).map((t) => new Date(t.completed_at!).getTime() - new Date(t.started_at!).getTime());
  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 1000) : null;
  const totals = usage.data as { calls: number; cost_usd: number; input_tokens: number; output_tokens: number; all_simulated: boolean };
  const spend = Number(totals.cost_usd);
  const tokens = Number(totals.input_tokens) + Number(totals.output_tokens);
  const model = selectModel({ agentTier: agent.model_tier, override: agent.model_override }, configuredModels());
  const agentNames = Object.fromEntries(agentRows.map((a) => [a.id, a.display_name]));
  const tenderTitles = await getTenderTitles([...taskRows.map((t) => t.tender_id), agent.current_tender_id]);
  const cur = rowOrThrow(currentTask, "the current task");

  return (
    <>
      <LiveRefresh tables={["agents", "tasks"]} debounceMs={500} />
      <Link href="/office" className="text-xs text-muted-foreground hover:text-foreground">
        ← Office
      </Link>
      <div className="mb-5 mt-3 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-3">
          <AgentAvatar slug={agent.slug} accent={dep?.accent ?? "slate"} size="lg" active={agent.status === "RUNNING"} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{agent.display_name}</h1>
            <p className="text-sm text-muted-foreground">
              {agent.role_title} · {dep?.name}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <AgentStatusBadge status={agent.status} />
              {def && !def.implemented && <Badge variant="outline">Not yet active in workflows</Badge>}
              {agent.status_reason && <span className="text-[12px] text-muted-foreground">{agent.status_reason}</span>}
            </div>
          </div>
        </div>
        {canAdminister(ctx.role) && <AgentControls agentId={agent.id} status={agent.status} />}
      </div>

      <div className="grid gap-4 xl:grid-cols-3 [&>*]:min-w-0">
        <div className="grid grid-cols-1 content-start gap-4 xl:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Current work</CardTitle>
            </CardHeader>
            <CardContent>
              {cur && agent.status !== "IDLE" ? (
                <div className="grid gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{cur.title}</p>
                    <TaskStatusBadge status={cur.status} />
                    {cur.tender_id && (
                      <Link href={`/tenders/${cur.tender_id}`} className="text-xs text-primary hover:underline">
                        {tenderTitles[cur.tender_id] ?? "Tender"}
                      </Link>
                    )}
                  </div>
                  {cur.status === "RUNNING" && (
                    <div className="max-w-md">
                      <Progress value={cur.progress} />
                      <p className="mt-1 text-[12px] text-cyan-300/90">{cur.progress_message}</p>
                    </div>
                  )}
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <p className="mb-1 text-[11px] text-muted-foreground">Input received</p>
                      <JsonView value={cur.input} />
                    </div>
                    <div>
                      <p className="mb-1 text-[11px] text-muted-foreground">Output</p>
                      <JsonView value={cur.output} />
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Idle. {agent.last_action ? `Last: ${agent.last_action} (${relativeTime(agent.last_action_at)}).` : "No work yet."}
                </p>
              )}
              {agent.next_expected_action && <p className="mt-3 text-[12px] text-muted-foreground">Next expected: {agent.next_expected_action}</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent tasks</CardTitle>
            </CardHeader>
            <CardContent>
              {taskRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tasks yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="py-1.5 pr-3 font-medium">Task</th>
                        <th className="py-1.5 pr-3 font-medium">Status</th>
                        <th className="py-1.5 pr-3 font-medium">Tender</th>
                        <th className="py-1.5 pr-3 font-medium">When</th>
                        <th className="py-1.5 font-medium">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {taskRows.map((t) => (
                        <tr key={t.id} className="border-t align-top">
                          <td className="py-2 pr-3">
                            {t.title}
                            {t.error && <p className="line-clamp-2 text-[11px] text-red-300">{t.error}</p>}
                          </td>
                          <td className="py-2 pr-3">
                            <TaskStatusBadge status={t.status} />
                            {t.retry_count > 0 && <p className="text-[11px] text-muted-foreground">{t.retry_count} retries</p>}
                          </td>
                          <td className="max-w-48 truncate py-2 pr-3">
                            {t.tender_id ? (
                              <Link href={`/tenders/${t.tender_id}`} className="hover:text-primary">
                                {tenderTitles[t.tender_id] ?? "Tender"}
                              </Link>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="py-2 pr-3 text-[12px] text-muted-foreground" title={formatDateTime(t.created_at)}>
                            {relativeTime(t.created_at)}
                          </td>
                          <td className="py-2">{t.status === "FAILED" && canOperate(ctx.role) && <TaskRetryButton taskId={t.id} />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <ActivityFeed initial={events} agentNames={agentNames} tenderTitles={tenderTitles} filter={{ agentId: id }} limit={40} />
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Performance and cost</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-3 text-[13px]">
                <Metric k="Completed (recent)" v={String(completed.length)} />
                <Metric k="Failed (recent)" v={String(failed.length)} />
                <Metric k="Avg. duration" v={avg === null ? "—" : `${avg}s`} />
                <Metric k="Tokens used" v={tokens.toLocaleString("en-ZA")} />
                <Metric k="Actual cost" v={formatUsd(spend)} />
                <Metric k="Model tier" v={humanize(agent.model_tier)} />
              </dl>
              <p className="mt-3 text-[11px] text-muted-foreground">
                Model: {model.model ?? "not configured (simulation mode makes no AI calls)"}
                {totals.calls > 0 && totals.all_simulated && " · all recorded usage is simulated"}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Responsibilities</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-2 text-[13px] text-muted-foreground">{agent.description}</p>
              <ul className="list-disc pl-5 text-[13px]">
                {agent.responsibilities.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Permissions</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div>
                <p className="mb-1.5 text-[11px] text-muted-foreground">Data categories (read)</p>
                <div className="flex flex-wrap gap-1">
                  {permRows.map((p) => (
                    <Badge key={p.data_category} variant="secondary">
                      {humanize(p.data_category)}
                    </Badge>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] text-muted-foreground">Tools</p>
                <div className="flex flex-wrap gap-1">
                  {agent.allowed_tools.map((t) => (
                    <Badge key={t} variant="outline" className="font-mono">
                      {t}
                    </Badge>
                  ))}
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Max concurrent tasks: {agent.max_concurrent_tasks}. Escalates after{" "}
                {(agent.escalation_policy as { maxConsecutiveFailures?: number }).maxConsecutiveFailures ?? "—"} consecutive failures.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Recent handoffs</CardTitle>
            </CardHeader>
            <CardContent>
              <HandoffList initial={handoffRows} agentNames={agentNames} tenderTitles={tenderTitles} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>State history</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="grid gap-1 text-[12px]">
                {transitionRows.map((t) => (
                  <li key={t.id} className="flex flex-wrap gap-x-2">
                    <span className="text-muted-foreground">{relativeTime(t.created_at)}</span>
                    <span>
                      {t.from_status ? `${humanize(t.from_status)} → ` : ""}
                      {humanize(t.to_status)}
                    </span>
                    {t.reason && <span className="text-muted-foreground">· {t.reason}</span>}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function Metric({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{k}</dt>
      <dd className="font-medium tabular-nums">{v}</dd>
    </div>
  );
}
