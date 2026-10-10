import Link from "next/link";
import type { Metadata } from "next";
import { PageHeader } from "@/components/command-centre/page-header";
import { ApprovalStatusBadge } from "@/components/command-centre/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApprovalCard, type PendingApproval } from "@/features/approvals/approval-card";
import { LiveRefresh } from "@/features/realtime/live-refresh";
import { canAdminister, requireContext } from "@/lib/data/context";
import { getApprovalHistory, getPendingApprovals } from "@/lib/data/queries";
import { formatDateTime, humanize } from "@/lib/format";

export const metadata: Metadata = { title: "Approvals" };

export default async function ApprovalsPage() {
  const ctx = await requireContext();
  const [pending, history] = await Promise.all([getPendingApprovals(ctx.organisation.id), getApprovalHistory(ctx.organisation.id)]);

  return (
    <>
      <LiveRefresh tables={["approvals"]} debounceMs={300} />
      <PageHeader title="Approvals" description="Nothing is submitted without a human decision here." />
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium">Waiting for you ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">No approvals are pending.</p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {pending.map((a) => (
              <ApprovalCard key={a.id} approval={a as unknown as PendingApproval} canDecide={canAdminister(ctx.role)} />
            ))}
          </div>
        )}
      </section>
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No decisions yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">Approval</th>
                    <th className="py-1.5 pr-3 font-medium">Tender</th>
                    <th className="py-1.5 pr-3 font-medium">Decision</th>
                    <th className="py-1.5 pr-3 font-medium">When</th>
                    <th className="py-1.5 font-medium">Comments</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((a) => {
                    const t = a.tenders as { id: string; title: string } | null;
                    return (
                      <tr key={a.id} className="border-t align-top">
                        <td className="py-2 pr-3">{humanize(a.type)}</td>
                        <td className="max-w-56 truncate py-2 pr-3">
                          {t ? (
                            <Link href={`/tenders/${t.id}`} className="hover:text-primary">
                              {t.title}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          <ApprovalStatusBadge status={a.status} />
                        </td>
                        <td className="py-2 pr-3 text-[12px] text-muted-foreground">{formatDateTime(a.approved_at ?? a.rejected_at ?? a.requested_at)}</td>
                        <td className="py-2 text-[12px] text-muted-foreground">{a.comments ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
