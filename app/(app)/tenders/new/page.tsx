import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/command-centre/page-header";
import { TenderForm } from "@/features/tenders/tender-form";
import { canOperate, requireContext } from "@/lib/data/context";

export const metadata: Metadata = { title: "New tender" };

export default async function NewTenderPage() {
  const ctx = await requireContext();
  if (!canOperate(ctx.role)) redirect("/tenders");
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="New tender" description="Record a tender opportunity. Only enter information published by the issuer." />
      <TenderForm />
    </div>
  );
}
