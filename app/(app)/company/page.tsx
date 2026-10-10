import type { Metadata } from "next";
import { PageHeader } from "@/components/command-centre/page-header";
import { CompanyForm } from "@/features/company/company-form";
import { canAdminister, requireContext } from "@/lib/data/context";
import { getServerSupabase } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Company profile" };

export default async function CompanyPage() {
  const ctx = await requireContext();
  const supabase = await getServerSupabase();
  const { data: profile } = await supabase.from("company_profiles").select("*").eq("organisation_id", ctx.organisation.id).maybeSingle();
  return (
    <>
      <PageHeader
        title="Company profile"
        description="The compliance and qualification agents check every tender against these facts. Nothing here is guessed; empty fields are reported as missing."
      />
      <CompanyForm profile={profile} canEdit={canAdminister(ctx.role)} />
    </>
  );
}
