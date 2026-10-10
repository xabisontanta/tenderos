import type { Metadata } from "next";
import { PageHeader } from "@/components/command-centre/page-header";
import { OfficeFloor } from "@/features/office/office-floor";
import { requireContext } from "@/lib/data/context";
import { getAgentFloor } from "@/lib/data/queries";

export const metadata: Metadata = { title: "Office" };

export default async function OfficePage() {
  const ctx = await requireContext();
  const floor = await getAgentFloor(ctx.organisation.id);
  return (
    <>
      <PageHeader title="Office" description="Your AI tender department at work. Lines appear only when one agent hands work to another." />
      <OfficeFloor initial={floor} />
    </>
  );
}
