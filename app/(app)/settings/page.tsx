import type { Metadata } from "next";
import { PageHeader } from "@/components/command-centre/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { KillSwitch } from "@/features/settings/kill-switch";
import { canAdminister, requireContext } from "@/lib/data/context";
import { getServerSupabase } from "@/lib/supabase/server";
import { formatDateTime, formatUsd, humanize } from "@/lib/format";
import { configuredModels } from "@/agents/runtime/model-routing";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await requireContext();
  const s = ctx.settings;
  const supabase = await getServerSupabase();
  const { data: members } = await supabase
    .from("organisation_members")
    .select("user_id,role,created_at")
    .eq("organisation_id", ctx.organisation.id)
    .order("created_at");
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id,full_name")
    .in(
      "id",
      (members ?? []).map((m) => m.user_id),
    );
  const names = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.full_name]));
  const models = configuredModels();

  return (
    <>
      <PageHeader title="Settings" description={ctx.organisation.name} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className={s.kill_switch ? "border-red-500/40" : undefined}>
          <CardHeader>
            <CardTitle>Kill switch</CardTitle>
            <CardDescription>Stops every agent in this organisation immediately.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <Badge variant={s.kill_switch ? "danger" : "secondary"}>{s.kill_switch ? "Engaged" : "Not engaged"}</Badge>
            <KillSwitch engaged={s.kill_switch} canChange={canAdminister(ctx.role)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Operating mode</CardTitle>
            <CardDescription>Simulation mode makes no AI calls and never submits anything outside TenderOS.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-[13px]">
            <Row k="Simulation mode" v={s.simulation_mode ? "On" : "Off"} />
            <Row k="Max tasks per workflow" v={String(s.max_tasks_per_workflow)} />
            <Row k="Default retries per task" v={String(s.default_max_retries)} />
            <Row k="Audit retention" v={`${s.audit_retention_days} days`} />
            <p className="text-[11px] text-muted-foreground">
              Real AI execution and live submission are not enabled in this release, so simulation mode cannot be turned off yet.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>AI budgets</CardTitle>
            <CardDescription>
              Real AI work stops and the run is blocked once the daily budget is spent. Monthly and per-tender limits are stored but not yet enforced.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-[13px]">
            <Row k="Daily" v={formatUsd(Number(s.daily_ai_budget_usd))} />
            <Row k="Monthly" v={formatUsd(Number(s.monthly_ai_budget_usd))} />
            <Row k="Per tender" v={formatUsd(Number(s.per_tender_budget_usd))} />
            <Row k="Warn at" v={`${s.budget_warning_pct}%`} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Model routing</CardTitle>
            <CardDescription>Set with the AI_MODEL_LOW, AI_MODEL_MID and AI_MODEL_HIGH environment variables.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-[13px]">
            {(["LOW", "MID", "HIGH"] as const).map((t) => (
              <Row key={t} k={`${humanize(t)} tier`} v={models[t] ?? "Not configured"} />
            ))}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Members</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1.5 text-[13px]">
              {(members ?? []).map((m) => (
                <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-1.5 first:border-t-0 first:pt-0">
                  <span>
                    {names[m.user_id] ?? "Unnamed member"}
                    {m.user_id === ctx.userId && <span className="text-muted-foreground"> (you)</span>}
                  </span>
                  <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
                    <Badge variant="outline">{humanize(m.role)}</Badge> joined {formatDateTime(m.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-medium tabular-nums">{v}</span>
    </div>
  );
}
