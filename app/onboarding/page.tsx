import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSupabase } from "@/lib/supabase/server";
import { pendingLegalAcceptances } from "@/lib/legal/status";
import { Logo } from "@/components/command-centre/logo";
import { Button } from "@/components/ui/button";
import { OnboardingForm } from "@/features/auth/onboarding-form";
import { signOut } from "@/features/auth/actions";
import { JoinInvitation } from "@/features/team/join-invitation";
import { readInviteCookie } from "@/lib/team/invite-cookie";
import { previewInvitation } from "@/lib/team/invite-preview";
import { ROLE_DESCRIPTIONS } from "@/lib/team/roles";

export const metadata: Metadata = { title: "Set up your organisation" };

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ own?: string }> }) {
  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if ((await pendingLegalAcceptances(supabase)).length > 0) redirect("/legal/accept?next=/onboarding");
  const { data: membership, error } = await supabase.from("organisation_members").select("organisation_id").eq("user_id", user.id).maybeSingle();
  // Not "no organisation": a failed lookup must not offer to create another.
  if (error) throw new Error("Could not load your organisation");
  if (membership) redirect("/");

  // An invitation in the visitor's cookie means they came to join an organisation, not to start one. They can
  // still choose to start their own (?own=1), which is a real choice: a person belongs to one organisation.
  const { own } = await searchParams;
  const token = own === "1" ? null : await readInviteCookie();
  const invite = token ? await previewInvitation(token) : null;

  if (invite?.status === "ok") {
    const role = ROLE_DESCRIPTIONS[invite.role];
    const matches = (user.email ?? "").toLowerCase() === invite.email;
    return (
      <Shell title={`Join ${invite.organisationName}`} subtitle={`You are invited as ${role.label}.`}>
        <div className="grid gap-4">
          <p className="rounded-md border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">{role.summary}</p>
          {matches ? (
            <JoinInvitation organisationName={invite.organisationName} />
          ) : (
            <div className="grid gap-3 text-xs leading-relaxed text-muted-foreground">
              <p role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-300">
                This invitation was sent to <strong className="break-all">{invite.email}</strong>, but you are signed in as{" "}
                <strong className="break-all">{user.email}</strong>. An invitation only works for the address it was sent to.
              </p>
              <form action={signOut}>
                <Button type="submit" variant="outline" className="w-full">
                  Sign out and use {invite.email}
                </Button>
              </form>
            </div>
          )}
          <p className="text-center text-xs text-muted-foreground">
            Want your own organisation instead?{" "}
            <Link className="text-primary hover:underline" href="/onboarding?own=1">
              Create one
            </Link>
            . You can belong to only one.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Set up your tender department" subtitle="We will create your organisation and install the agent team.">
      {invite?.status === "invalid" && (
        <p role="status" className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Your invitation is no longer valid: it may have expired or been withdrawn. Ask the person who invited you to send a new one, or set up your own
          organisation below.
        </p>
      )}
      <OnboardingForm />
      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
        Your organisation starts in simulation mode: agents run the full workflow against tenders you mark as simulations, without AI calls or external
        submissions. Company profile and documents are added later.
      </p>
      {!invite && (
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          Joining a colleague&apos;s organisation, or a client&apos;s? Open the link from your invitation email in this browser instead of creating one here.
        </p>
      )}
    </Shell>
  );
}

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <Logo className="size-8" />
          <div>
            <h1 className="text-base font-semibold">{title}</h1>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-6">{children}</div>
      </div>
    </main>
  );
}
