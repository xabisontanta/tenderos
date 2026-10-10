import type { Metadata } from "next";
import { CheckCircle2, CircleAlert, CircleDashed } from "lucide-react";
import { PageHeader } from "@/components/command-centre/page-header";
import { Badge } from "@/components/ui/badge";
import { DocumentActions } from "@/features/documents/document-actions";
import { DownloadButton } from "@/features/documents/download-button";
import { UploadForm } from "@/features/documents/upload-form";
import { canAdminister, canOperate, requireContext } from "@/lib/data/context";
import { DOCUMENT_TYPES, canReadDocumentType, documentType } from "@/lib/domain/documents";
import { formatDate } from "@/lib/format";
import { getServerSupabase } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Documents" };

function formatSize(bytes: number | null) {
  if (bytes === null) return "size unknown";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function DocumentsPage() {
  const ctx = await requireContext();
  const supabase = await getServerSupabase();
  const { data: docs, error } = await supabase
    .from("company_documents")
    .select("id, doc_type, title, file_name, size_bytes, expires_at, verified, created_at")
    .eq("organisation_id", ctx.organisation.id)
    .is("archived_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  const today = new Date().toISOString().slice(0, 10);
  const byType = new Map<string, NonNullable<typeof docs>>();
  for (const d of docs ?? []) byType.set(d.doc_type, [...(byType.get(d.doc_type) ?? []), d]);
  const isAdmin = canAdminister(ctx.role);

  return (
    <>
      <PageHeader
        title="Documents"
        description="Upload your CIPC certificate, tax status, B-BBEE and the other documents tenders ask for. The agents check every tender against these files and list the ones to attach in each bid pack."
      />

      <section aria-labelledby="checklist" className="mb-6">
        <h2 id="checklist" className="mb-2 text-sm font-semibold">
          Checklist
        </h2>
        <ul className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {DOCUMENT_TYPES.filter((t) => t.key !== "other").map((t) => {
            const current = byType.get(t.key) ?? [];
            const valid = current.filter((d) => !d.expires_at || d.expires_at >= today);
            const state = valid.length === 0 ? (current.length ? "expired" : "missing") : valid.some((d) => d.verified) ? "ok" : "unverified";
            return (
              <li key={t.key} className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs">
                {state === "ok" ? (
                  <CheckCircle2 className="size-4 text-emerald-400" aria-hidden />
                ) : state === "missing" ? (
                  <CircleDashed className="size-4 text-muted-foreground" aria-hidden />
                ) : (
                  <CircleAlert className="size-4 text-amber-400" aria-hidden />
                )}
                <span className="flex-1">{t.label}</span>
                <span className="text-muted-foreground">
                  {state === "ok" ? "On file" : state === "missing" ? "Missing" : state === "expired" ? "Expired" : "Needs verifying"}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Bank letters, director IDs and proof of address are only shared with the Document Manager agent, so the bid agents never read them.
        </p>
      </section>

      {canOperate(ctx.role) ? (
        <section aria-labelledby="upload" className="mb-6">
          <h2 id="upload" className="mb-2 text-sm font-semibold">
            Upload a document
          </h2>
          <UploadForm organisationId={ctx.organisation.id} />
          {!isAdmin && (
            <p className="mt-2 text-[11px] text-muted-foreground">An owner or admin must verify documents you upload before compliance relies on them.</p>
          )}
        </section>
      ) : (
        <p className="mb-6 text-xs text-muted-foreground">Viewers can download documents but not upload them.</p>
      )}

      <section aria-labelledby="library">
        <h2 id="library" className="mb-2 text-sm font-semibold">
          Uploaded documents ({docs?.length ?? 0})
        </h2>
        {!docs?.length ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            No documents yet. Start with your CIPC registration and SARS tax compliance status.
          </p>
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {docs.map((d) => {
              const expired = d.expires_at !== null && d.expires_at < today;
              return (
                <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{d.title}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {documentType(d.doc_type)?.label ?? d.doc_type} · {d.file_name} · {formatSize(d.size_bytes)} · uploaded {formatDate(d.created_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {d.expires_at && (
                      <Badge variant={expired ? "danger" : "outline"}>
                        {expired ? "Expired" : "Expires"} {formatDate(d.expires_at)}
                      </Badge>
                    )}
                    <Badge variant={d.verified ? "success" : "warning"}>{d.verified ? "Verified" : "Unverified"}</Badge>
                  </div>
                  {canReadDocumentType(d.doc_type, isAdmin) ? (
                    <DownloadButton id={d.id} />
                  ) : (
                    <span className="text-[11px] text-muted-foreground">Owners and admins only</span>
                  )}
                  {isAdmin && <DocumentActions id={d.id} verified={d.verified} />}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
