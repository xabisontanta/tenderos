import Link from "next/link";
import type { Metadata } from "next";
import { ActivityFeed } from "@/components/command-centre/activity-feed";
import { PageHeader } from "@/components/command-centre/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { requireContext } from "@/lib/data/context";
import { getRecentEvents, getTenderTitles } from "@/lib/data/queries";
import { getServerSupabase } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Activity" };

const PAGE = 100;

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const ctx = await requireContext();
  const { before: rawBefore } = await searchParams;
  const before = rawBefore && !Number.isNaN(Date.parse(rawBefore)) ? new Date(rawBefore).toISOString() : undefined;
  const supabase = await getServerSupabase();
  const [events, agents] = await Promise.all([
    getRecentEvents(ctx.organisation.id, { limit: PAGE, before }),
    supabase.from("agents").select("id,display_name").eq("organisation_id", ctx.organisation.id),
  ]);
  const agentNames = Object.fromEntries((agents.data ?? []).map((a) => [a.id, a.display_name]));
  const tenderTitles = await getTenderTitles(events.map((e) => e.tender_id));
  const last = events.at(-1);

  return (
    <>
      <PageHeader title="Activity" description="Every recorded agent event, newest first. Events are append-only." />
      <Card>
        <CardContent className="pt-4">
          {before ? (
            <ActivityFeed key={before} initial={events} agentNames={agentNames} tenderTitles={tenderTitles} limit={PAGE} live={false} />
          ) : (
            <ActivityFeed initial={events} agentNames={agentNames} tenderTitles={tenderTitles} limit={PAGE} />
          )}
          <div className="mt-4 flex gap-2">
            {before && (
              <Button asChild variant="outline" size="sm">
                <Link href="/activity">Newest</Link>
              </Button>
            )}
            {events.length === PAGE && last && (
              <Button asChild variant="outline" size="sm">
                <Link href={`/activity?before=${encodeURIComponent(last.created_at)}`}>Older</Link>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
