import Link from "next/link";
import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/command-centre/page-header";
import { SimulationBadge, TenderStatusBadge } from "@/components/command-centre/status-badge";
import { Button } from "@/components/ui/button";
import { LiveRefresh } from "@/features/realtime/live-refresh";
import { canOperate, requireContext } from "@/lib/data/context";
import { getServerSupabase } from "@/lib/supabase/server";
import { formatDateTime, formatZar, provinceLabel, relativeTime } from "@/lib/format";
import { ALL_TENDER_STATUSES, pipelineStage, type TenderStatus } from "@/lib/domain/tender-state";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Tenders" };

const PAGE = 25;
const STAGES = ["all", "new", "qualifying", "preparing", "approval", "submitted", "won", "lost", "closed"] as const;

export default async function TendersPage({ searchParams }: { searchParams: Promise<{ stage?: string; page?: string; q?: string }> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const stage = (STAGES as readonly string[]).includes(sp.stage ?? "") ? sp.stage! : "all";
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const q = (sp.q ?? "").trim().slice(0, 100);

  const supabase = await getServerSupabase();
  let query = supabase
    .from("tenders")
    .select("id,title,reference_number,issuing_organisation,status,closing_at,province,estimated_value_zar,is_simulation", { count: "exact" })
    .eq("organisation_id", ctx.organisation.id)
    .order("closing_at", { ascending: true })
    .range((page - 1) * PAGE, page * PAGE - 1);
  if (stage !== "all") {
    const statuses = ALL_TENDER_STATUSES.filter((s) => pipelineStage(s) === stage);
    query = query.in("status", statuses);
  }
  if (q) {
    const safe = q.replace(/[%_,()]/g, " ");
    query = query.or(`title.ilike.%${safe}%,reference_number.ilike.%${safe}%,issuing_organisation.ilike.%${safe}%`);
  }
  const { data: tenders, count } = await query;
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));
  const link = (o: Record<string, string | number>) => {
    const p = new URLSearchParams({ stage, ...(q ? { q } : {}), ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])) });
    return `/tenders?${p}`;
  };

  return (
    <>
      <LiveRefresh tables={["tenders"]} debounceMs={800} />
      <PageHeader
        title="Tenders"
        description={`${count ?? 0} tender${count === 1 ? "" : "s"}`}
        actions={
          canOperate(ctx.role) && (
            <Button asChild size="sm">
              <Link href="/tenders/new">
                <Plus /> New tender
              </Link>
            </Button>
          )
        }
      />
      <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <nav aria-label="Filter by stage" className="flex gap-1 overflow-x-auto">
          {STAGES.map((s) => (
            <Link
              key={s}
              href={link({ stage: s, page: 1 })}
              aria-current={stage === s ? "page" : undefined}
              className={cn("rounded-md px-2.5 py-1 text-xs capitalize text-muted-foreground hover:bg-accent", stage === s && "bg-accent text-foreground")}
            >
              {s}
            </Link>
          ))}
        </nav>
        <form className="flex gap-2" role="search">
          <input type="hidden" name="stage" value={stage} />
          <label htmlFor="q" className="sr-only">
            Search tenders
          </label>
          <input
            id="q"
            name="q"
            defaultValue={q}
            placeholder="Search title, reference, organisation"
            className="h-8 w-64 rounded-md border bg-transparent px-2.5 text-xs"
          />
          <Button size="sm" variant="outline" type="submit">
            Search
          </Button>
        </form>
      </div>

      {(tenders ?? []).length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <p className="text-sm text-muted-foreground">No tenders here yet.</p>
          {canOperate(ctx.role) && (
            <Button asChild size="sm" className="mt-3">
              <Link href="/tenders/new">Create a tender</Link>
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Tender
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Closes
                </th>
                <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                  Province
                </th>
                <th scope="col" className="hidden px-3 py-2 text-right font-medium lg:table-cell">
                  Est. value
                </th>
              </tr>
            </thead>
            <tbody>
              {tenders!.map((t) => (
                <tr key={t.id} className="border-t hover:bg-muted/20">
                  <td className="px-3 py-2.5">
                    <Link href={`/tenders/${t.id}`} className="font-medium hover:text-primary">
                      {t.title}
                    </Link>
                    <p className="text-[11px] text-muted-foreground">
                      {t.reference_number ? `${t.reference_number} · ` : ""}
                      {t.issuing_organisation}
                    </p>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      <TenderStatusBadge status={t.status as TenderStatus} />
                      {t.is_simulation && <SimulationBadge />}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-[12px]" title={formatDateTime(t.closing_at)}>
                    {relativeTime(t.closing_at)}
                  </td>
                  <td className="hidden px-3 py-2.5 text-[12px] md:table-cell">{provinceLabel(t.province)}</td>
                  <td className="hidden px-3 py-2.5 text-right text-[12px] tabular-nums lg:table-cell">{formatZar(t.estimated_value_zar)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <nav aria-label="Pagination" className="mt-3 flex items-center justify-end gap-2 text-xs">
          {page > 1 && (
            <Button asChild size="sm" variant="outline">
              <Link href={link({ page: page - 1 })}>Previous</Link>
            </Button>
          )}
          <span className="text-muted-foreground">
            Page {page} of {pages}
          </span>
          {page < pages && (
            <Button asChild size="sm" variant="outline">
              <Link href={link({ page: page + 1 })}>Next</Link>
            </Button>
          )}
        </nav>
      )}
    </>
  );
}
