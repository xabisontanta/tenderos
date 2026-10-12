import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/command-centre/logo";
import { Button, buttonVariants } from "@/components/ui/button";
import { signOut } from "@/features/auth/actions";
import { MfaChallengeForm } from "@/features/security/mfa-challenge-form";
import { needsSecondFactor } from "@/lib/auth/mfa";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { getServerSupabase } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Verify it is you", robots: { index: false } };

/**
 * The second step of signing in for someone who has set up an authenticator app. The middleware sends every password-only
 * session here before anything else opens. Someone who already passed it (or has no authenticator) goes on to where
 * they were headed; someone who reaches it with no usable authenticator is told what to do instead of seeing a form
 * that cannot work.
 */
export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { next } = await searchParams;
  const target = safeRedirectPath(next);
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === "aal2") redirect(target);

  const { data: listed, error } = await supabase.auth.mfa.listFactors();
  const factors = (listed?.totp ?? []).map((f) => ({ id: f.id, name: f.friendly_name?.trim() || "Authenticator app" }));

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <Logo className="size-8" />
          <div>
            <h1 className="text-base font-semibold">Verify it is you</h1>
            <p className="text-xs text-muted-foreground">Open your authenticator app and enter the code it shows for TenderOS.</p>
          </div>
        </div>
        <div className="grid gap-4 rounded-xl border bg-card p-6">
          {error ? (
            <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              We could not load your authenticators. Reload the page in a moment.
            </p>
          ) : factors.length > 0 ? (
            <MfaChallengeForm factors={factors} next={target} />
          ) : (
            <div className="grid gap-3 text-xs leading-relaxed text-muted-foreground">
              <p className="font-medium text-foreground">{needsSecondFactor(aal) ? "No authenticator app to check against" : "No authenticator app set up"}</p>
              <p>
                {needsSecondFactor(aal)
                  ? "Your account asks for a second step, but it is not one this page can check. Ask the owner of your organisation to contact TenderOS support."
                  : "You have not set up an authenticator app yet, so there is nothing to verify. You can add one in Settings, Security."}
              </p>
              {!needsSecondFactor(aal) && (
                <Link href="/settings#security" className={cn(buttonVariants(), "w-full")}>
                  Set up an authenticator app
                </Link>
              )}
            </div>
          )}
          <form action={signOut}>
            <Button type="submit" variant="ghost" size="sm" className="w-full">
              Sign out
            </Button>
          </form>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Lost the device that has your authenticator? Ask the owner of your organisation to contact TenderOS support to reset it. We will confirm it is you
            first.
          </p>
        </div>
      </div>
    </main>
  );
}
