import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { getServerSupabase } from "@/lib/supabase/server";
import { readInviteCookie } from "@/lib/team/invite-cookie";
import { previewInvitation } from "@/lib/team/invite-preview";
import { ROLE_DESCRIPTIONS } from "@/lib/team/roles";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Invitation", robots: { index: false } };

/**
 * Where the link in an invitation email lands, after /invite/<token> moved the token into a cookie. Shows who is
 * inviting to what and which address the invitation is for (taken from the database, and not trusted for
 * anything: the address that signs in is what counts). It never says whether that address has an account:
 * "Create account" and "Sign in" are always both offered. A signed-in person without an organisation goes on to
 * the page that accepts it.
 */
export default async function InvitePage() {
  const token = await readInviteCookie();
  const preview = token ? await previewInvitation(token) : ({ status: "invalid" } as const);

  if (preview.status === "error") {
    return (
      <Notice title="We could not check your invitation">
        Something went wrong on our side. Reload this page in a moment, or open the link in your email again.
      </Notice>
    );
  }
  if (preview.status === "invalid") {
    return (
      <Notice title="This invitation link did not work">
        It may have expired, been withdrawn or already been used, or it was not opened in this browser. Open the link from your invitation email again. If that
        does not help, ask the person who invited you to send a new one.
        <Link href="/login" className={cn(buttonVariants({ variant: "outline" }), "mt-4 w-full")}>
          Go to sign in
        </Link>
      </Notice>
    );
  }

  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    const { data: membership, error } = await supabase.from("organisation_members").select("organisation_id").eq("user_id", user.id).maybeSingle();
    if (error) throw new Error("Could not load your organisation");
    if (!membership) redirect("/onboarding");
    if (membership.organisation_id === preview.organisationId) {
      return (
        <Notice title={`You are already in ${preview.organisationName}`}>
          <Link href="/" className={cn(buttonVariants(), "mt-4 w-full")}>
            Open TenderOS
          </Link>
        </Notice>
      );
    }
    return (
      <Notice title="You already belong to another organisation">
        A person belongs to one organisation. To join {preview.organisationName}, leave your current organisation first (Settings, Team, Leave), then open the
        link in your invitation email again.
        <Link href="/settings#team" className={cn(buttonVariants({ variant: "outline" }), "mt-4 w-full")}>
          Open Settings
        </Link>
      </Notice>
    );
  }

  const role = ROLE_DESCRIPTIONS[preview.role];
  return (
    <div className="grid gap-4">
      <div>
        <h2 className="text-sm font-semibold">Join {preview.organisationName}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          You have been invited to {preview.organisationName} on TenderOS as <strong className="text-foreground">{role.label}</strong>.
        </p>
      </div>
      <p className="rounded-md border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">{role.summary}</p>
      <p className="text-xs text-muted-foreground">
        The invitation is for <strong className="break-all text-foreground">{preview.email}</strong>. Use that address to create your account or to sign in; an
        invitation cannot be used with any other.
      </p>
      <div className="grid gap-2">
        <Link href="/signup" className={cn(buttonVariants(), "w-full")}>
          Create an account
        </Link>
        <Link href="/login?next=%2Finvite" className={cn(buttonVariants({ variant: "outline" }), "w-full")}>
          Sign in
        </Link>
      </div>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid text-xs leading-relaxed text-muted-foreground">
      <h2 className="mb-2 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </div>
  );
}
