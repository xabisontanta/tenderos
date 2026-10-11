import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Logo } from "@/components/command-centre/logo";
import { AcceptForm } from "@/features/legal/accept-form";
import { pendingLegalAcceptances } from "@/lib/legal/status";
import { LEGAL_TITLES, LEGAL_VERSIONS } from "@/lib/legal/versions";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { getServerSupabase } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Review our terms" };

/**
 * Where a signed-in user who has not accepted the terms and privacy notice now in
 * force is sent: someone who signed up without the consent fields, or everyone when a
 * new version is published. Outside the app layout, because that layout would send
 * them straight back here.
 */
export default async function AcceptLegalPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { next } = await searchParams;
  const target = safeRedirectPath(next);
  const pending = await pendingLegalAcceptances(supabase);
  if (pending.length === 0) redirect(target);

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <Logo className="size-8" />
          <div>
            <h1 className="text-base font-semibold">Review our terms</h1>
            <p className="text-xs text-muted-foreground">Please accept the current documents to continue using TenderOS.</p>
          </div>
        </div>
        <div className="grid gap-4 rounded-xl border bg-card p-6">
          <ul className="grid gap-1 text-sm text-muted-foreground">
            <li>
              {LEGAL_TITLES.terms}, version {LEGAL_VERSIONS.terms}
            </li>
            <li>
              {LEGAL_TITLES.privacy}, version {LEGAL_VERSIONS.privacy}
            </li>
          </ul>
          <AcceptForm next={target} />
        </div>
      </div>
    </main>
  );
}
