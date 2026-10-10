import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { ActivityFeed } from "@/components/command-centre/activity-feed";
import { JsonView } from "@/components/command-centre/json-view";
import { ApprovalStatusBadge, RunStatusBadge, SimulationBadge, TaskStatusBadge, TenderStatusBadge } from "@/components/command-centre/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HandoffList } from "@/features/operations/handoff-list";
import { LiveRefresh } from "@/features/realtime/live-refresh";
import { TenderActions } from "@/features/tenders/tender-actions";
import { WorkflowTimeline } from "@/features/tenders/workflow-timeline";
import {
  CompliancePanel,
  type DocumentLinks,
  PricingPanel,
  ProposalPanel,
  QaPanel,
  QualificationPanel,
  RequirementsPanel,
  SubmissionPanel,
} from "@/features/tenders/output-panels";
import { canAdminister, canOperate, requireContext } from "@/lib/data/context";
import { BidDelivery, type DeliveryDocument } from "@/features/email/bid-delivery";
import { getRecentEvents, type TaskSummary } from "@/lib/data/queries";
import { getServerSupabase } from "@/lib/supabase/server";
import { formatDateTime, formatZar, humanize, provinceLabel, relativeTime } from "@/lib/format";
import type { TenderStatus } from "@/lib/domain/tender-state";

export const metadata: Metadata = { title: "Tender" };

export default async function TenderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireContext();
  const supabase = await getServerSupabase();

  const { data: tender } = await supabase.from("tenders").select("*").eq("id", id).maybeSingle();
  if (!tender) notFound();

  const [runs, history, approvals, handoffs, agents, submissions, events, costs] = await Promise.all([
    supabase.from("workflow_runs").select("*").eq("tender_id", id).order("created_at", { ascending: false }),
    supabase.from("tender_status_history").select("*").eq("tender_id", id).order("created_at"),
    supabase.from("approvals").select("*").eq("tender_id", id).order("requested_at", { ascending: false }),
    supabase.from("handoffs").select("*").eq("tender_id", id).order("created_at", { ascending: false }).limit(50),
    supabase.from("agents").select("id,display_name").eq("organisation_id", ctx.organisation.id),
    supabase.from("submission_records").select("*").eq("tender_id", id).order("created_at", { ascending: false }),
    getRecentEvents(ctx.organisation.id, { tenderId: id, limit: 100 }),
    supabase.from("cost_usage").select("cost_usd,is_simulated").eq("tender_id", id),
  ]);

  const latestRun = runs.data?.[0] ?? null;
  const activeRun = (runs.data ?? []).find((r) => ["PENDING", "RUNNING", "WAITING_APPROVAL", "BLOCKED"].includes(r.status)) ?? null;
  const { data: tasksData } = latestRun
    ? await supabase.from("tasks").select("*").eq("workflow_run_id", latestRun.id).order("created_at")
    : { data: [] as never[] };
  const tasks = tasksData ?? [];
  const output = (step: string) => tasks.find((t) => t.step_key === step && t.status === "COMPLETED")?.output ?? null;
  const agentNames = Object.fromEntries((agents.data ?? []).map((a) => [a.id, a.display_name]));
  const totalCost = (costs.data ?? []).reduce((s, c) => s + Number(c.cost_usd), 0);
  const submission = submissions.data?.[0] ?? null;
  const documentLinks = await bidPackLinks(supabase, output("compliance"));
  const awaitingDelivery = submission?.status === "ACTION_REQUIRED" && !submission.is_simulation && canAdminister(ctx.role);
  const delivery = awaitingDelivery ? await deliveryData(supabase, ctx.organisation.id, ctx.userId, tender, output("submission")) : null;

  return (
    <>
      <LiveRefresh tables={["tasks", "tenders", "workflow_runs", "approvals", "handoffs"]} tenderId={id} debounceMs={350} />
      <div className="mb-5 flex flex-col gap-3">
        <Link href="/tenders" className="text-xs text-muted-foreground hover:text-foreground">
          ← Tenders
        </Link>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span data-testid="tender-status" className="contents">
                <TenderStatusBadge status={tender.status as TenderStatus} />
              </span>
              {tender.is_simulation && <SimulationBadge />}
              {latestRun && <RunStatusBadge status={latestRun.status} />}
            </div>
            <h1 className="mt-2 text-xl font-semibold tracking-tight">{tender.title}</h1>
            <p className="text-sm text-muted-foreground">
              {tender.reference_number ? `${tender.reference_number} · ` : ""}
              {tender.issuing_organisation} · closes {formatDateTime(tender.closing_at)} ({relativeTime(tender.closing_at)})
            </p>
          </div>
          {canOperate(ctx.role) && (
            <TenderActions
              tenderId={tender.id}
              status={tender.status as TenderStatus}
              isSimulation={tender.is_simulation}
              activeRunId={activeRun?.id ?? null}
              simulationEnabled={ctx.settings.simulation_mode}
              killSwitch={ctx.settings.kill_switch}
            />
          )}
        </div>
        {latestRun?.error && (latestRun.status === "BLOCKED" || latestRun.status === "CANCELLED" || latestRun.status === "FAILED") && (
          <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-200">
            {latestRun.status === "BLOCKED" ? "Workflow blocked: " : `Workflow ${humanize(latestRun.status).toLowerCase()}: `}
            {latestRun.error}
          </p>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-3 [&>*]:min-w-0">
        <div className="grid grid-cols-1 content-start gap-4 xl:col-span-2">
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="qualification">Qualification</TabsTrigger>
              <TabsTrigger value="requirements">Requirements</TabsTrigger>
              <TabsTrigger value="compliance">Compliance</TabsTrigger>
              <TabsTrigger value="proposal">Proposal</TabsTrigger>
              <TabsTrigger value="pricing">Pricing</TabsTrigger>
              <TabsTrigger value="qa">QA</TabsTrigger>
              <TabsTrigger value="submission">Submission</TabsTrigger>
              <TabsTrigger value="tasks">Tasks</TabsTrigger>
              <TabsTrigger value="audit">Audit trail</TabsTrigger>
            </TabsList>
            <Card className="mt-3">
              <CardContent className="pt-4">
                <TabsContent value="overview" className="mt-0">
                  <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
                    <Item k="Issuing organisation" v={tender.issuing_organisation} />
                    <Item k="Reference" v={tender.reference_number ?? "—"} />
                    <Item k="Province" v={provinceLabel(tender.province)} />
                    <Item k="Sector" v={tender.sector ?? "—"} />
                    <Item k="Estimated value" v={formatZar(tender.estimated_value_zar)} />
                    <Item k="Published" v={formatDateTime(tender.published_at)} />
                    <Item k="Closing" v={formatDateTime(tender.closing_at)} />
                    <Item k="Questions deadline" v={formatDateTime(tender.questions_deadline_at)} />
                    <Item
                      k="Briefing"
                      v={
                        tender.briefing_at
                          ? `${formatDateTime(tender.briefing_at)}${tender.briefing_compulsory ? " (compulsory)" : ""}`
                          : tender.briefing_compulsory
                            ? "Compulsory, date not recorded"
                            : "—"
                      }
                    />
                    <Item k="Briefing location" v={tender.briefing_location ?? "—"} />
                    <Item k="Submission method" v={humanize(tender.submission_method)} />
                    <Item k="Submission destination" v={tender.submission_destination ?? "—"} />
                    <Item
                      k="AI cost"
                      v={`$${totalCost.toFixed(4)}${(costs.data ?? []).every((c) => c.is_simulated) && costs.data?.length ? " (simulated, no AI calls)" : ""}`}
                    />
                    <div>
                      <dt className="text-[11px] text-muted-foreground">Source</dt>
                      <dd>
                        {tender.source_url ? (
                          <a
                            href={tender.source_url}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                            className="inline-flex items-center gap-1 text-primary hover:underline"
                          >
                            Open source <ExternalLink className="size-3" aria-hidden />
                          </a>
                        ) : (
                          "—"
                        )}
                      </dd>
                    </div>
                  </dl>
                  {tender.description && <p className="mt-4 whitespace-pre-wrap text-[13px] text-muted-foreground">{tender.description}</p>}
                </TabsContent>
                <TabsContent value="qualification" className="mt-0">
                  <QualificationPanel output={output("qualification")} />
                </TabsContent>
                <TabsContent value="requirements" className="mt-0">
                  <RequirementsPanel output={output("analysis")} />
                </TabsContent>
                <TabsContent value="compliance" className="mt-0">
                  <CompliancePanel output={output("compliance")} links={documentLinks} />
                </TabsContent>
                <TabsContent value="proposal" className="mt-0">
                  <ProposalPanel output={output("proposal")} />
                </TabsContent>
                <TabsContent value="pricing" className="mt-0">
                  <PricingPanel output={output("pricing")} />
                </TabsContent>
                <TabsContent value="qa" className="mt-0">
                  <QaPanel output={output("qa")} />
                </TabsContent>
                <TabsContent value="submission" className="mt-0">
                  {delivery && submission && (
                    <div className="mb-4">
                      <BidDelivery submissionId={submission.id} method={tender.submission_method} destination={tender.submission_destination} {...delivery} />
                    </div>
                  )}
                  <SubmissionPanel output={output("submission")} record={submission} links={documentLinks} />
                </TabsContent>
                <TabsContent value="tasks" className="mt-0">
                  {tasks.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No tasks yet.</p>
                  ) : (
                    <ul className="grid gap-2">
                      {tasks.map((t) => (
                        <li key={t.id} className="rounded-lg border p-2.5">
                          <details>
                            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-sm">
                              <span className="font-medium">{t.title}</span>
                              <TaskStatusBadge status={t.status} />
                              <span className="text-[11px] text-muted-foreground">
                                {agentNames[t.agent_id]} · attempt {t.retry_count + 1} of {t.max_retries + 1}
                              </span>
                            </summary>
                            <div className="mt-2 grid gap-2 md:grid-cols-2">
                              <div>
                                <p className="mb-1 text-[11px] text-muted-foreground">Input</p>
                                <JsonView value={t.input} />
                              </div>
                              <div>
                                <p className="mb-1 text-[11px] text-muted-foreground">Output</p>
                                <JsonView value={t.output} />
                              </div>
                            </div>
                            {t.error && <p className="mt-2 text-[12px] text-red-300">Error: {t.error}</p>}
                          </details>
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>
                <TabsContent value="audit" className="mt-0">
                  <h3 className="mb-2 text-xs font-semibold text-muted-foreground">Status history</h3>
                  <ol className="mb-5 grid gap-1 text-[13px]">
                    {(history.data ?? []).map((h) => (
                      <li key={h.id} className="flex flex-wrap gap-x-2">
                        <span className="font-mono text-[11px] text-muted-foreground">{formatDateTime(h.created_at)}</span>
                        <span>
                          {h.from_status ? `${humanize(h.from_status)} → ` : ""}
                          <strong className="font-medium">{humanize(h.to_status)}</strong>
                        </span>
                        <span className="text-muted-foreground">
                          by {h.actor_type === "agent" && h.actor_agent_id ? (agentNames[h.actor_agent_id] ?? "agent") : h.actor_type}
                          {h.reason && ` · ${h.reason}`}
                        </span>
                      </li>
                    ))}
                  </ol>
                  <h3 className="mb-2 text-xs font-semibold text-muted-foreground">Events</h3>
                  <ActivityFeed initial={events} agentNames={agentNames} filter={{ tenderId: id }} limit={100} />
                </TabsContent>
              </CardContent>
            </Card>
          </Tabs>
        </div>

        <div className="grid grid-cols-1 content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Workflow progress</CardTitle>
            </CardHeader>
            <CardContent>
              {latestRun ? (
                <WorkflowTimeline tasks={tasks as TaskSummary[]} agentNames={agentNames} />
              ) : (
                <p className="text-sm text-muted-foreground">No workflow has run for this tender.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Approvals</CardTitle>
            </CardHeader>
            <CardContent>
              {(approvals.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">None requested.</p>
              ) : (
                <ul className="grid gap-2">
                  {approvals.data!.map((a) => (
                    <li key={a.id} className="rounded-lg border p-2.5 text-[13px]">
                      <div className="flex items-center justify-between gap-2">
                        <span>{humanize(a.type)}</span>
                        <ApprovalStatusBadge status={a.status} />
                      </div>
                      <p className="mt-1 text-[12px] text-muted-foreground">{a.summary}</p>
                      {a.comments && <p className="mt-1 text-[12px]">“{a.comments}”</p>}
                      {a.status === "PENDING" && (
                        <Link href="/approvals" className="mt-1 inline-block text-xs text-primary hover:underline">
                          Review
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Handoffs</CardTitle>
            </CardHeader>
            <CardContent>
              <HandoffList initial={handoffs.data ?? []} agentNames={agentNames} tenderId={id} limit={50} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

/** The uploaded documents the compliance check relied on; download links are signed on click. */
async function bidPackLinks(supabase: Awaited<ReturnType<typeof getServerSupabase>>, compliance: unknown): Promise<DocumentLinks> {
  const items = (compliance as { items?: Array<{ document_id?: string | null }> } | null)?.items ?? [];
  const ids = [...new Set(items.flatMap((i) => (i.document_id ? [i.document_id] : [])))];
  if (ids.length === 0) return {};
  const { data: docs } = await supabase.from("company_documents").select("id,title,archived_at").in("id", ids);
  return Object.fromEntries((docs ?? []).map((d) => [d.id, { title: d.title, available: !d.archived_at }]));
}

type Tender = { title: string; reference_number: string | null; issuing_organisation: string; closing_at: string; id: string };

/** Everything the delivery panel needs; the covering message uses only facts on file and leaves out what is missing. */
async function deliveryData(supabase: Awaited<ReturnType<typeof getServerSupabase>>, orgId: string, userId: string, tender: Tender, submissionOutput: unknown) {
  const attachments = (submissionOutput as { attachments?: Array<{ label: string; document_id: string }> } | null)?.attachments ?? [];
  const ids = attachments.map((a) => a.document_id);
  const [{ data: mailboxes }, { data: docs }, { data: profile }, { data: sent }] = await Promise.all([
    supabase.from("email_accounts").select("id,from_address").eq("organisation_id", orgId).eq("user_id", userId).is("revoked_at", null).order("created_at"),
    ids.length
      ? supabase.from("company_documents").select("id,file_name,size_bytes").in("id", ids).is("archived_at", null)
      : Promise.resolve({ data: [] as Array<{ id: string; file_name: string; size_bytes: number | null }> }),
    supabase
      .from("company_profiles")
      .select("legal_name,trading_name,registration_number,csd_number,contact_person,contact_phone,contact_email,authorised_signatory")
      .eq("organisation_id", orgId)
      .maybeSingle(),
    supabase
      .from("email_messages")
      .select("id,to_address,from_address,status,error,created_at")
      .eq("tender_id", tender.id)
      .order("created_at", { ascending: false }),
  ]);
  const documents: DeliveryDocument[] = (docs ?? []).map((d) => ({
    id: d.id,
    file_name: d.file_name,
    size_bytes: d.size_bytes,
    label: attachments.find((a) => a.document_id === d.id)?.label ?? d.file_name,
  }));
  const p = profile;
  const ref = tender.reference_number ? `${tender.reference_number}: ` : "";
  const lines = [
    "Dear Sir or Madam,",
    "",
    `Please find attached our bid for ${ref}${tender.title}, issued by ${tender.issuing_organisation}, closing ${formatDateTime(tender.closing_at)} (SAST).`,
    "",
    p?.legal_name ? `Bidder: ${p.legal_name}${p.trading_name ? ` (trading as ${p.trading_name})` : ""}` : null,
    p?.registration_number ? `CIPC registration: ${p.registration_number}` : null,
    p?.csd_number ? `CSD supplier number: ${p.csd_number}` : null,
    p?.contact_person || p?.contact_phone || p?.contact_email
      ? `Contact: ${[p?.contact_person, p?.contact_phone, p?.contact_email].filter(Boolean).join(", ")}`
      : null,
    "",
    documents.length ? "Attached:" : null,
    ...documents.map((d) => `- ${d.label} (${d.file_name})`),
    documents.length ? "" : null,
    "Please confirm receipt.",
    "",
    "Kind regards,",
    p?.authorised_signatory ?? null,
    p?.legal_name ?? null,
  ].filter((l): l is string => l !== null);
  return {
    defaultSubject: `Bid submission: ${ref}${tender.title}`.slice(0, 300),
    defaultBody: lines.join("\n"),
    mailboxes: mailboxes ?? [],
    documents,
    sent: sent ?? [],
  };
}
