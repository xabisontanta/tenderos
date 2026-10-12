"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Clock, FileQuestion, FileWarning, RotateCcw, XCircle } from "lucide-react";
import type { ComponentType } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { fetchTenderDocuments } from "./actions";

export type TenderDocumentStatus = "PENDING" | "DOWNLOADED" | "FAILED" | "UNSUPPORTED" | "TOO_LARGE";

export interface TenderDocumentRow {
  id: string;
  file_name: string;
  status: TenderDocumentStatus;
  error: string | null;
  size_bytes: number | null;
  page_count: number | null;
  fetched_at: string | null;
}

const STATUS: Record<
  TenderDocumentStatus,
  { label: string; variant: "success" | "warning" | "danger" | "outline" | "info"; icon: ComponentType<{ className?: string }> }
> = {
  PENDING: { label: "Waiting to be fetched", variant: "info", icon: Clock },
  DOWNLOADED: { label: "Fetched", variant: "success", icon: CheckCircle2 },
  FAILED: { label: "Failed", variant: "danger", icon: XCircle },
  UNSUPPORTED: { label: "Not read yet", variant: "warning", icon: FileQuestion },
  TOO_LARGE: { label: "Too large", variant: "warning", icon: FileWarning },
};

function size(bytes: number | null): string {
  if (bytes === null) return "";
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** How often the list refreshes itself while documents are still being fetched. */
const POLL_MS = 4000;

/**
 * The tender's documents as the portal lists them, with what happened to each. A person can fetch them (or fetch again, which
 * also retries the failed ones) and retry a single failed document. Only PDFs are read by the AI; a Word, Excel or zip file is
 * shown as "Not read yet" with the reason, never hidden. While anything is waiting the list refreshes itself.
 */
export function TenderDocuments({
  tenderId,
  rows,
  listed,
  canFetch,
  isSimulation,
  aiEnabled,
}: {
  tenderId: string;
  rows: TenderDocumentRow[];
  /** How many documents the portal lists for this tender. */
  listed: number;
  canFetch: boolean;
  isSimulation: boolean;
  aiEnabled: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const waiting = rows.some((r) => r.status === "PENDING");

  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [waiting, router]);

  function fetchNow(documentId?: string) {
    setError(null);
    start(async () => {
      const r = await fetchTenderDocuments(tenderId, documentId);
      if (!r.ok) {
        setError(r.error);
        toast.error(r.error);
        return;
      }
      toast.success(r.data!.waiting > 0 ? "Fetching the documents" : "Nothing left to fetch");
      router.refresh();
    });
  }

  const fetched = rows.filter((r) => r.status === "DOWNLOADED").length;
  const failed = rows.some((r) => r.status === "FAILED");

  return (
    <section aria-label="Tender documents" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted-foreground" aria-live="polite">
          {isSimulation
            ? "Simulated tenders have no documents."
            : listed === 0
              ? "The portal lists no documents for this tender."
              : `${fetched} of ${rows.length || listed} fetched.`}
        </p>
        {canFetch && !isSimulation && listed > 0 && (
          <Button type="button" size="sm" variant="outline" disabled={busy || waiting} onClick={() => fetchNow()}>
            <RotateCcw /> {rows.length === 0 ? "Fetch documents" : failed ? "Fetch again" : "Check for new documents"}
          </Button>
        )}
      </div>
      <p className="text-[12px] text-muted-foreground">
        TenderOS keeps a private copy of each PDF. The Tender Analyst reads them only when AI assistance is on
        {aiEnabled ? " (it is on)" : " (it is off for this organisation)"}. Word, Excel and zip files are listed but not read yet: open them on the portal and
        check them yourself.
      </p>
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <caption className="sr-only">Documents listed by the portal for this tender</caption>
            <thead>
              <tr className="border-b text-[11px] text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  Document
                </th>
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  Status
                </th>
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  Details
                </th>
                <th scope="col" className="py-1.5 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = STATUS[r.status];
                const Icon = s.icon;
                return (
                  <tr key={r.id} className="border-b align-top last:border-0">
                    <th scope="row" className="max-w-[18rem] break-words py-2 pr-3 font-medium">
                      {r.file_name}
                    </th>
                    <td className="py-2 pr-3">
                      <Badge variant={s.variant}>
                        <Icon aria-hidden /> {s.label}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 text-[12px] text-muted-foreground">
                      {r.status === "DOWNLOADED"
                        ? [
                            size(r.size_bytes),
                            r.page_count ? `${r.page_count} page${r.page_count === 1 ? "" : "s"}` : null,
                            r.fetched_at ? `fetched ${formatDateTime(r.fetched_at)}` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : r.error}
                    </td>
                    <td className="py-2 text-right">
                      {canFetch && r.status === "FAILED" && (
                        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => fetchNow(r.id)} aria-label={`Retry ${r.file_name}`}>
                          Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">
          {error}
        </p>
      )}
    </section>
  );
}
