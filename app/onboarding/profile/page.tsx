import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Logo } from "@/components/command-centre/logo";
import { OnboardingWizard } from "@/features/onboarding/wizard";
import { canAdminister, requireContext } from "@/lib/data/context";
import { getServerSupabase } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Tell us what you bid on" };

/**
 * The optional setup wizard shown right after an organisation is created, and from the
 * dashboard until it is finished or skipped. Outside the app layout, like /onboarding,
 * so nothing competes with the four questions.
 */
export default async function OnboardingProfilePage() {
  const ctx = await requireContext();
  if (!canAdminister(ctx.role)) redirect("/");
  // Done or skipped already: the company page is where this is edited now.
  if (ctx.settings.onboarding_completed_at) redirect("/company");

  const supabase = await getServerSupabase();
  const { data: profile, error } = await supabase
    .from("company_profiles")
    .select("sectors, provinces, cidb_grade, keywords")
    .eq("organisation_id", ctx.organisation.id)
    .maybeSingle();
  if (error) throw new Error("Could not load the company profile");

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-8">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center gap-3">
          <Logo className="size-8" />
          <div>
            <h1 className="text-base font-semibold">Tell us what you bid on</h1>
            <p className="text-xs text-muted-foreground">
              Four quick questions so the Tender Scout looks in the right places. Everything is optional and you can change it later on the Company page.
            </p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-6">
          <OnboardingWizard
            initial={{
              sectors: profile?.sectors ?? [],
              provinces: profile?.provinces ?? [],
              cidb_grade: profile?.cidb_grade ?? "",
              keywords: profile?.keywords ?? [],
            }}
          />
        </div>
      </div>
    </main>
  );
}
