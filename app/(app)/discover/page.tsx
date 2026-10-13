import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CircleAlert, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/command-centre/page-header";
import { TenderStatusBadge } from "@/components/command-centre/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ProvinceScanner } from "@/features/discovery/province-scanner";
import { DELIVERY_METHODS } from "@/features/discovery/provinces";
import { LiveRefresh } from "@/features/realtime/live-refresh";
import { canAdminister, canOperate, requireContext } from "@/lib/data/context";
import { getServerSupabase } from "@/lib/supabase/server";
import { pageCount, pageFromParam, pageRange } from "@/lib/pagination";
import { formatDateTime, provinceLabel, relativeTime } from "@/lib/format";
import type { TenderStatus } from "@/lib/domain/tender-state";

export const metadata: Metadata = { title: "Discover" };

const RUN_VARIANT = { QUEUED: "secondary", RUNNING: "warning", COMPLETED: "success", FAILED: "danger" } as const;

const PAGE_SIZE = 50;

export default async function DiscoverPage({ searchParams }: { searchParams: Promise<{ province?: string; method?: string; page?: string }> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const supabase = await getServerSupabase();
  const s = ctx.settings;
  const page = pageFromParam(sp.page);
  const [from, to] = pageRange(page, PAGE_SIZE);

  let tendersQuery = supabase
    .from("tenders")
    .select("id,title,reference_number,issuing_organisation,province,closing_at,status,sector,source_url,created_at,submission_method,submission_destination", {
      count: "exact",
    })
    .eq("organisation_id", ctx.organisation.id)
    .not("source_ref", "is", null)
    .gt("closing_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .order("id") // a tie-break, so a tender never appears on two pages or none while the list changes
    .range(from, to);
  if (sp.province) tendersQuery = tendersQuery.eq("province", sp.province);
  const method = DELIVERY_METHODS.find((m) => m.value === sp.method)?.value;
  tendersQuery = method
    ? tendersQuery.eq("submission_method", method)
    : tendersQuery.in("submission_method", s.watched_methods as (typeof DELIVERY_METHODS)[number]["value"][]);
  // Filters reset the page; the page links keep the filters.
  const href = (next: { province?: string | null; method?: string | null; page?: number }) => {
    const q = new URLSearchParams();
    const pv = next.province === undefined ? sp.province : next.province;
    const mv = next.method === undefined ? method : next.method;
    if (pv) q.set("province", pv);
    if (mv) q.set("method", mv);
    if (next.page && next.page > 1) q.set("page", String(next.page));
    const qs = q.toString();
    return qs ? `/discover?${qs}` : "/discover";
  };
  const filterHref = (next: { province?: string | null; method?: string | null }) => href(next);
  const methodLabel = (v: string) => DELIVERY_METHODS.find((m) => m.value === v)?.label ?? v;

  const [runsRes, tendersRes, profileRes] = await Promise.all([
    supabase.from("discovery_runs").select("*").eq("organisation_id", ctx.organisation.id).order("created_at", { ascending: false }).limit(8),
    tendersQuery,
    supabase
      .from("company_profiles")
      .select("csd_number,tax_pin,registration_number,authorised_signatory")
      .eq("organisation_id", ctx.organisation.id)
      .maybeSingle(),
  ]);
  // A page past the end (a stale link, or the list shrank) is not an error: go back to the first page.
  if (tendersRes.error?.code === "PGRST103" && page > 1) redirect(href({}));
  if (tendersRes.error) throw new Error(`Could not load the tenders: ${tendersRes.error.message}`);
  if (runsRes.error) throw new Error(`Could not load the scans: ${runsRes.error.message}`);
  if (profileRes.error) throw new Error(`Could not load the company profile: ${profileRes.error.message}`);
  const { data: runs } = runsRes;
  const { data: tenders, count } = tendersRes;
  const { data: profile } = profileRes;
  const pages = pageCount(count, PAGE_SIZE);
  const scanning = (runs ?? []).some((r) => r.status === "QUEUED" || r.status === "RUNNING");
  const profileReady = Boolean(profile?.csd_number && profile?.tax_pin && profile?.registration_number && profile?.authorised_signatory);

  return (
    <>
      <LiveRefresh tables={["discovery_runs", "tenders"]} debounceMs={800} />
      <PageHeader
        title="Discover tenders"
        description={
          s.watched_provinces.length
            ? `Watching ${s.watched_provinces.map(provinceLabel).join(", ")}. Scanned every morning${s.last_discovery_at ? `; last scan ${relativeTime(s.last_discovery_at)}` : ""}.`
            : "Choose provinces and the Tender Scout will find every open government tender in them."
        }
      />

      {!profileReady && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-400" aria-hidden />
          <div>
            <p className="font-medium">The compliance agent will stop every tender until your company profile is complete.</p>
            <p className="text-muted-foreground">
              Government bids need your CIPC registration, CSD number, tax compliance PIN and an authorised signatory.{" "}
              <Link href="/company" className="underline underline-offset-2">
                Complete the company profile
              </Link>{" "}
              and stopped tenders resume by themselves.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3 [&>*]:min-w-0">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Provinces</CardTitle>
            <CardDescription>Source: National Treasury eTenders (etenders.gov.za), the official portal for published government tenders.</CardDescription>
          </CardHeader>
          <CardContent>
            <ProvinceScanner
              watched={s.watched_provinces}
              watchedMethods={s.watched_methods}
              autoRun={s.auto_run_workflows}
              canChange={canAdminister(ctx.role)}
              canScan={canOperate(ctx.role)}
              scanning={scanning}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recent scans</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {(runs ?? []).length === 0 && <p className="text-sm text-muted-foreground">No scans yet.</p>}
            {(runs ?? []).map((r) => (
              <div key={r.id} className="rounded-lg border p-2.5 text-[13px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{r.provinces.map(provinceLabel).join(", ")}</span>
                  <Badge variant={RUN_VARIANT[r.status]}>{r.status === "RUNNING" ? "Scanning" : r.status.toLowerCase()}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {r.status === "COMPLETED"
                    ? `${r.matched} open in scope · ${r.created_tenders} new · ${r.started_workflows} sent to agents${r.rows_skipped > 0 ? ` · ${r.rows_skipped} of ${r.rows_seen} rows could not be used` : ""}`
                    : r.status === "FAILED"
                      ? r.error
                      : r.status === "RUNNING"
                        ? "Reading eTenders"
                        : "Waiting for the worker"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {r.trigger === "schedule" ? "Morning scan" : "Manual"} · {formatDateTime(r.created_at)}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <section className="mt-6" aria-labelledby="found">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 id="found" className="text-sm font-semibold">
            Open tenders found ({count ?? 0})
          </h2>
          <nav aria-label="Filter by delivery method" className="flex flex-wrap gap-1 text-xs">
            <Link
              href={filterHref({ method: null })}
              className={!method ? "rounded bg-accent px-2 py-1" : "rounded px-2 py-1 text-muted-foreground hover:bg-accent"}
            >
              Any method
            </Link>
            {s.watched_methods.map((m) => (
              <Link
                key={m}
                href={filterHref({ method: m })}
                className={method === m ? "rounded bg-accent px-2 py-1" : "rounded px-2 py-1 text-muted-foreground hover:bg-accent"}
              >
                {methodLabel(m)}
              </Link>
            ))}
          </nav>
          <nav aria-label="Filter by province" className="flex flex-wrap gap-1 text-xs">
            <Link
              href={filterHref({ province: null })}
              className={!sp.province ? "rounded bg-accent px-2 py-1" : "rounded px-2 py-1 text-muted-foreground hover:bg-accent"}
            >
              All
            </Link>
            {s.watched_provinces.map((p) => (
              <Link
                key={p}
                href={filterHref({ province: p })}
                className={sp.province === p ? "rounded bg-accent px-2 py-1" : "rounded px-2 py-1 text-muted-foreground hover:bg-accent"}
              >
                {provinceLabel(p)}
              </Link>
            ))}
          </nav>
        </div>
        {(tenders ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            {scanning ? "The Tender Scout is scanning eTenders now." : "Nothing found yet. Choose provinces above and scan."}
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
                    Agent progress
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Closes
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                    Apply by
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                    Province
                  </th>
                </tr>
              </thead>
              <tbody>
                {tenders!.map((t) => (
                  <tr key={t.id} className="border-t hover:bg-muted/20">
                    <td className="max-w-xl px-3 py-2.5">
                      <Link href={`/tenders/${t.id}`} className="line-clamp-2 font-medium hover:text-primary">
                        {t.title}
                      </Link>
                      <p className="text-[11px] text-muted-foreground">
                        {t.reference_number ? `${t.reference_number} · ` : ""}
                        {t.issuing_organisation}
                        {t.source_url && (
                          <>
                            {" · "}
                            <a
                              href={t.source_url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
                            >
                              documents <ExternalLink className="size-3" aria-hidden />
                            </a>
                          </>
                        )}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <TenderStatusBadge status={t.status as TenderStatus} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs">
                      {formatDateTime(t.closing_at)}
                      <span className="block text-muted-foreground">{relativeTime(t.closing_at)}</span>
                    </td>
                    <td className="hidden max-w-[14rem] px-3 py-2.5 text-xs md:table-cell">
                      {methodLabel(t.submission_method)}
                      {t.submission_method === "EMAIL" && t.submission_destination && (
                        <span className="block truncate text-muted-foreground">{t.submission_destination}</span>
                      )}
                    </td>
                    <td className="hidden px-3 py-2.5 text-xs md:table-cell">{provinceLabel(t.province)}</td>
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
                <Link href={href({ page: page - 1 })}>Previous</Link>
              </Button>
            )}
            <span className="text-muted-foreground">
              Page {page} of {pages}
            </span>
            {page < pages && (
              <Button asChild size="sm" variant="outline">
                <Link href={href({ page: page + 1 })}>Next</Link>
              </Button>
            )}
          </nav>
        )}
      </section>
    </>
  );
}
