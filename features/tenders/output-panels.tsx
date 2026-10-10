import { AlertTriangle, CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import { JsonView } from "@/components/command-centre/json-view";
import { Badge } from "@/components/ui/badge";
import { DownloadButton } from "@/features/documents/download-button";
import { qualificationOutputSchema } from "@/agents/qualification/schema";
import { analysisOutputSchema } from "@/agents/analysis/schema";
import { complianceOutputSchema } from "@/agents/compliance/schema";
import { proposalOutputSchema } from "@/agents/proposal/schema";
import { pricingOutputSchema } from "@/agents/pricing/schema";
import { qaOutputSchema } from "@/agents/qa/schema";
import { submissionOutputSchema } from "@/agents/submission/schema";
import { humanize } from "@/lib/format";
import { cn } from "@/lib/utils";

function ResultIcon({ result }: { result: string }) {
  if (result === "PASS" || result === "VALID" || result === "EXTRACTED" || result === "DRAFTED")
    return <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" aria-label="Pass" />;
  if (result === "FAIL" || result === "EXPIRED") return <XCircle className="size-3.5 shrink-0 text-red-400" aria-label="Fail" />;
  if (result === "WARN" || result === "OPEN_ISSUE" || result === "EXPIRING_SOON")
    return <AlertTriangle className="size-3.5 shrink-0 text-amber-400" aria-label="Warning" />;
  return <CircleHelp className="size-3.5 shrink-0 text-muted-foreground" aria-label="Unknown" />;
}

function Empty({ what }: { what: string }) {
  return <p className="text-sm text-muted-foreground">{what} has not run yet.</p>;
}

function Simulated({ on }: { on: boolean }) {
  return on ? (
    <p className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-200">
      Simulation output. Derived only from the tender record; no AI analysis was performed and nothing was invented.
    </p>
  ) : null;
}

export function QualificationPanel({ output }: { output: unknown }) {
  if (!output) return <Empty what="Qualification" />;
  const p = qualificationOutputSchema.safeParse(output);
  if (!p.success) return <JsonView value={output} />;
  const q = p.data;
  return (
    <div>
      <Simulated on={q.simulated} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge variant={q.decision === "QUALIFIED" ? "success" : "danger"}>{humanize(q.decision)}</Badge>
        {q.confirmation_required && <Badge variant="warning">Requires confirmation</Badge>}
        <span className="text-xs text-muted-foreground">
          Fit score: {q.fit_score ?? "—"}
          {q.fit_score !== null && "%"} (shown for context; hard disqualifiers always decide)
        </span>
      </div>
      {q.hard_disqualifiers.length > 0 && (
        <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-200">
          <p className="font-medium">Hard disqualifiers</p>
          <ul className="mt-1 list-disc pl-5 text-[13px]">
            {q.hard_disqualifiers.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      )}
      <ul className="grid gap-1.5">
        {q.factors.map((f) => (
          <li key={f.key} className="flex gap-2 rounded-md border p-2 text-[13px]">
            <ResultIcon result={f.result} />
            <div>
              <p className="font-medium">
                {f.label} <span className="text-[11px] font-normal text-muted-foreground">· {humanize(f.result)}</span>
              </p>
              <p className="text-[12px] text-muted-foreground">{f.evidence}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RequirementsPanel({ output }: { output: unknown }) {
  if (!output) return <Empty what="Requirements analysis" />;
  const p = analysisOutputSchema.safeParse(output);
  if (!p.success) return <JsonView value={output} />;
  return (
    <div>
      <Simulated on={p.data.simulated} />
      <ul className="grid gap-1.5">
        {p.data.requirements.map((r) => (
          <li key={r.id} className="flex gap-2 rounded-md border p-2 text-[13px]">
            <ResultIcon result={r.status} />
            <div className="min-w-0">
              <p>
                {r.text} {r.mandatory && <Badge variant="outline">Mandatory</Badge>}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {humanize(r.category)} · source:{" "}
                {r.source.kind === "TENDER_RECORD" ? `tender record (${r.source.field})` : `document ${r.source.document_id} p.${r.source.page}`}
              </p>
            </div>
          </li>
        ))}
      </ul>
      {p.data.gaps.length > 0 && (
        <div className="mt-3 rounded-md border border-amber-500/30 p-3">
          <p className="text-xs font-medium text-amber-300">Gaps</p>
          <ul className="mt-1 list-disc pl-5 text-[12px] text-muted-foreground">
            {p.data.gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Uploaded company documents a panel refers to, keyed by document id. Links are signed on click. */
export type DocumentLinks = Record<string, { title: string; available: boolean }>;

function DocumentLink({ id, links }: { id: string | null | undefined; links: DocumentLinks }) {
  const doc = id ? links[id] : undefined;
  if (!doc) return null;
  return doc.available ? (
    <DownloadButton id={id!} label={doc.title} className="text-[11px] text-primary" />
  ) : (
    <span className="text-[11px] text-muted-foreground">{doc.title} (removed from Documents)</span>
  );
}

export function CompliancePanel({ output, links = {} }: { output: unknown; links?: DocumentLinks }) {
  if (!output) return <Empty what="Compliance review" />;
  const p = complianceOutputSchema.safeParse(output);
  if (!p.success) return <JsonView value={output} />;
  return (
    <div>
      <Simulated on={p.data.simulated} />
      {p.data.continued_in_simulation && (
        <p className="mb-3 text-[12px] text-amber-300">Items are missing. The simulation continued; a live run stops here at Missing information.</p>
      )}
      <ul className="grid gap-1.5">
        {p.data.items.map((i) => (
          <li key={i.key} className="flex gap-2 rounded-md border p-2 text-[13px]">
            <ResultIcon result={i.status} />
            <div>
              <p>
                {i.label} {i.mandatory && <Badge variant="outline">Mandatory</Badge>}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {humanize(i.status)} · {i.evidence}
              </p>
              <DocumentLink id={i.document_id} links={links} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProposalPanel({ output }: { output: unknown }) {
  if (!output) return <Empty what="Proposal drafting" />;
  const p = proposalOutputSchema.safeParse(output);
  if (!p.success) return <JsonView value={output} />;
  return (
    <div>
      <Simulated on={p.data.simulated} />
      <ul className="grid gap-1.5">
        {p.data.sections.map((s) => (
          <li key={s.key} className="rounded-md border p-2 text-[13px]">
            <div className="flex items-center gap-2">
              <ResultIcon result={s.status} />
              <p className="font-medium">{s.title}</p>
              <Badge variant={s.status === "DRAFTED" ? "success" : "warning"} className="ml-auto">
                {humanize(s.status)}
              </Badge>
            </div>
            {s.content ? (
              <p className="mt-1 whitespace-pre-wrap text-[12px]">{s.content}</p>
            ) : (
              <p className="mt-1 text-[12px] text-muted-foreground">Needs: {s.needs.join("; ")}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PricingPanel({ output }: { output: unknown }) {
  if (!output) return <Empty what="Pricing" />;
  const p = pricingOutputSchema.safeParse(output);
  if (!p.success) return <JsonView value={output} />;
  return (
    <div className="grid gap-3">
      <Simulated on={p.data.simulated} />
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant={p.data.status === "READY_FOR_APPROVAL" ? "success" : "warning"}>{humanize(p.data.status)}</Badge>
        <span className="text-muted-foreground">
          VAT {Math.round(p.data.vat_rate * 100)}% · {p.data.lines.length} lines · subtotal {p.data.subtotal_zar ?? "not available"}
        </span>
      </div>
      <ul className="list-disc pl-5 text-[13px] text-muted-foreground">
        {p.data.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

export function QaPanel({ output }: { output: unknown }) {
  if (!output) return <Empty what="Quality assurance" />;
  const p = qaOutputSchema.safeParse(output);
  if (!p.success) return <JsonView value={output} />;
  return (
    <div>
      <Simulated on={p.data.simulated} />
      <Badge variant={p.data.verdict === "PASS" ? "success" : p.data.verdict === "CONDITIONAL" ? "warning" : "danger"} className="mb-3">
        Verdict: {humanize(p.data.verdict)}
      </Badge>
      <ul className="grid gap-1.5">
        {p.data.checks.map((c) => (
          <li key={c.key} className={cn("flex gap-2 rounded-md border p-2 text-[13px]")}>
            <ResultIcon result={c.result} />
            <div>
              <p className="font-medium">{c.label}</p>
              <p className="text-[12px] text-muted-foreground">{c.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SubmissionPanel({
  output,
  record,
  links = {},
}: {
  output: unknown;
  links?: DocumentLinks;
  record: { status: string; is_simulation: boolean; package_hash: string | null; submitted_at: string | null; method: string } | null;
}) {
  if (!output && !record) return <Empty what="Submission" />;
  const p = submissionOutputSchema.safeParse(output);
  return (
    <div className="grid gap-3 text-[13px]">
      {record?.is_simulation && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-200">
          Simulated submission. No bid was sent to any portal, mailbox or tender box.
        </p>
      )}
      {record && (
        <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Status</dt>
          <dd>{humanize(record.status)}</dd>
          <dt className="text-muted-foreground">Method</dt>
          <dd>{humanize(record.method)}</dd>
          <dt className="text-muted-foreground">Package hash</dt>
          <dd className="break-all font-mono text-[11px]">{record.package_hash ?? "—"}</dd>
        </dl>
      )}
      {p.success && (
        <>
          <p>{p.data.receipt_note}</p>
          {p.data.attachments.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">Company documents for the bid pack</p>
              <ul className="grid gap-1">
                {p.data.attachments.map((a) => (
                  <li key={a.document_id} className="flex flex-wrap items-center gap-2">
                    <span>{a.label}</span>
                    <DocumentLink id={a.document_id} links={links} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ul className="flex flex-wrap gap-2 text-xs">
            {Object.entries(p.data.verified).map(([k, v]) => (
              <li key={k}>
                <Badge variant={v ? "success" : "warning"}>
                  {humanize(k)} {v ? "verified" : "not verified"}
                </Badge>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
