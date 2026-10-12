import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServerSupabase } from "@/lib/supabase/server";
import { pendingLegalAcceptances } from "@/lib/legal/status";
import { Logo } from "@/components/command-centre/logo";
import { OnboardingForm } from "@/features/auth/onboarding-form";

export const metadata: Metadata = { title: "Set up your organisation" };

export default async function OnboardingPage() {
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

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <Logo className="size-8" />
          <div>
            <h1 className="text-base font-semibold">Set up your tender department</h1>
            <p className="text-xs text-muted-foreground">We will create your organisation and install the agent team.</p>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-6">
          <OnboardingForm />
          <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
            Your organisation starts in simulation mode: agents run the full workflow against tenders you mark as simulations, without AI calls or external
            submissions. Company profile and documents are added later.
          </p>
        </div>
      </div>
    </main>
  );
}
