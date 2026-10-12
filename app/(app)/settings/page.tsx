import type { Metadata } from "next";
import { PageHeader } from "@/components/command-centre/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { KillSwitch } from "@/features/settings/kill-switch";
import { DataExport } from "@/features/settings/data-export";
import { MailboxSettings } from "@/features/email/mailbox-settings";
import { AutofillSettings } from "@/features/autofill/autofill-settings";
import { googleConfig } from "@/lib/email/gmail";
import { canAdminister, canOperate, requireContext } from "@/lib/data/context";
import { getServerSupabase } from "@/lib/supabase/server";
import { formatUsd, humanize } from "@/lib/format";
import { TeamMembers, type MemberRow } from "@/features/team/team-members";
import { SecuritySettings, type FactorRow } from "@/features/security/security-settings";
import { RequireMfaSwitch } from "@/features/security/require-mfa-switch";
import { InvitationsPanel, type InvitationRow } from "@/features/team/invitations-panel";
import { configuredModels } from "@/agents/runtime/model-routing";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const s = ctx.settings;
  const supabase = await getServerSupabase();
  const { data: members, error: membersError } = await supabase.rpc("list_members", { p_org: ctx.organisation.id });
  // Owners and admins see who has been invited (the table's policy hides it from everyone else).
  const { data: invitations, error: invitationsError } = canAdminister(ctx.role)
    ? await supabase
        .from("organisation_invitations")
        .select("id,email,role,created_at,expires_at")
        .eq("organisation_id", ctx.organisation.id)
        .is("accepted_at", null)
        .is("revoked_at", null)
        .order("created_at", { ascending: false })
    : { data: [], error: null };
  // The person's own authenticator apps (verified ones are on; an unverified one is a setup that was never finished).
  const { data: factorList, error: factorsError } = await supabase.auth.mfa.listFactors();
  const factors: FactorRow[] = (factorList?.all ?? [])
    .filter((f) => f.factor_type === "totp")
    .map((f) => ({ id: f.id, name: f.friendly_name?.trim() || "Authenticator app", verified: f.status === "verified", createdAt: f.created_at }));
  const { data: mailboxes } = await supabase
    .from("email_accounts")
    .select("id,user_id,provider,from_address,smtp_host,status,last_error")
    .eq("organisation_id", ctx.organisation.id)
    .is("revoked_at", null)
    .order("created_at");
  const { data: autofillTokens } = canOperate(ctx.role)
    ? await supabase
        .from("autofill_tokens")
        .select("id,label,created_at,last_used_at,expires_at")
        .eq("organisation_id", ctx.organisation.id)
        .eq("user_id", ctx.userId)
        .is("revoked_at", null)
        .order("created_at", { ascending: false })
    : { data: [] };
  const models = configuredModels();

  return (
    <>
      <PageHeader title="Settings" description={ctx.organisation.name} />
      {sp.email === "connected" && <p className="mb-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">Gmail connected.</p>}
      {sp.email === "verify" && (
        <p role="alert" className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          Your organisation requires an authenticator for this. Verify with your authenticator (or set one up under Security), then connect Gmail again.
        </p>
      )}
      {sp.email === "failed" && (
        <p className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">
          Gmail was not connected. Try again and allow TenderOS to send email.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card id="security" className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Security</CardTitle>
            <CardDescription>Protect your account with a second step when you sign in.</CardDescription>
          </CardHeader>
          <CardContent>
            {factorsError ? (
              <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">
                Your authenticators could not be loaded. Try again in a moment.
              </p>
            ) : (
              <div className="grid gap-4">
                <SecuritySettings factors={factors} />
                <RequireMfaSwitch on={s.require_mfa} isOwner={ctx.role === "owner"} hasAuthenticator={factors.some((f) => f.verified)} />
              </div>
            )}
          </CardContent>
        </Card>
        <Card id="email" className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Email for sending bids</CardTitle>
            <CardDescription>
              Each member connects their own mailbox. When a tender asks for bids by email, an owner or admin sends the approved bid from their mailbox with the
              documents attached.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MailboxSettings
              mailboxes={mailboxes ?? []}
              currentUserId={ctx.userId}
              isAdmin={canAdminister(ctx.role)}
              canConnect={canAdminister(ctx.role)}
              gmailAvailable={googleConfig() !== null}
            />
          </CardContent>
        </Card>
        {canOperate(ctx.role) && (
          <Card id="browser-helper" className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Browser helper</CardTitle>
              <CardDescription>
                Fills tender portal forms in your own browser with the company profile and attaches your verified documents. You check every field and submit it
                yourself.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AutofillSettings tokens={autofillTokens ?? []} />
            </CardContent>
          </Card>
        )}
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
        <Card id="team" className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Team</CardTitle>
            <CardDescription>
              Everyone in {ctx.organisation.name}. Auditors and accountants who work in your account join as viewers: read-only, with no way to change anything.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {membersError ? (
              <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">
                The team could not be loaded. Try again in a moment.
              </p>
            ) : (
              <TeamMembers members={(members ?? []) as MemberRow[]} currentUserId={ctx.userId} currentRole={ctx.role} />
            )}
            {canAdminister(ctx.role) && (
              <div className="mt-6 border-t pt-4">
                {invitationsError ? (
                  <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">
                    Invitations could not be loaded. Try again in a moment.
                  </p>
                ) : (
                  <InvitationsPanel invitations={(invitations ?? []) as InvitationRow[]} actorRole={ctx.role} />
                )}
              </div>
            )}
          </CardContent>
        </Card>
        {ctx.role === "owner" && (
          <Card id="your-data" className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Your data</CardTitle>
              <CardDescription>
                Download everything TenderOS holds for this organisation as one JSON file: company profile, tenders, approvals, sent emails, members and the
                audit trail. It never includes passwords, mailbox credentials, browser pairing codes or the contents of your uploaded files. Each download is
                recorded in the audit trail. To have the organisation or a member erased, ask the TenderOS Information Officer.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataExport />
            </CardContent>
          </Card>
        )}
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
