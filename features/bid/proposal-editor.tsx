"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bot, CheckCircle2, CircleAlert, FileWarning } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { BidEditState, SectionStatus } from "@/lib/domain/bid-content";
import { formatDateTime } from "@/lib/format";
import { saveProposalSection, setSectionReviewed } from "./actions";

export interface SectionView {
  section_key: string;
  title: string;
  version: number;
  content: string | null;
  status: SectionStatus;
  ai_generated: boolean;
  needs: string[];
  warnings: string[];
  fact_ids: string[];
  requirement_ids: string[];
  edited_by: string | null;
  edited_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export interface HistoryView {
  ref: string;
  version: number;
  change: string;
  changed_by: string | null;
  changed_at: string;
}

const STATUS: Record<SectionStatus, { label: string; variant: "success" | "warning" | "danger" }> = {
  REVIEWED: { label: "Reviewed", variant: "success" },
  DRAFT: { label: "Draft: not reviewed yet", variant: "warning" },
  MISSING_INFORMATION: { label: "Missing information", variant: "danger" },
};

const CHANGE: Record<string, string> = {
  SEEDED: "Drafted by TenderOS",
  RESEEDED: "Drafted again by TenderOS",
  EDITED: "Edited",
  REVIEWED: "Reviewed",
  UNREVIEWED: "Review taken back",
};

const who = (people: Record<string, string>, id: string | null) => (id ? (people[id] ?? "a former team member") : "TenderOS");

/**
 * The proposal for a person to write and review. The Proposal Writer's draft is only a start: each section is shown with
 * whether the AI wrote the text, what it rests on, what is still missing, and who last edited and who reviewed it. Saving text
 * makes it theirs; marking a section reviewed is the person's statement that it is right and complete. QA and the approval see
 * this text, and a section that is not reviewed counts as unfinished.
 */
export function ProposalEditor({
  tenderId,
  sections,
  history,
  requirements,
  people,
  editState,
  canEdit,
}: {
  tenderId: string;
  sections: SectionView[];
  history: HistoryView[];
  /** Requirement id to its text, for the "based on" lines. */
  requirements: Record<string, string>;
  people: Record<string, string>;
  editState: BidEditState;
  canEdit: boolean;
}) {
  const reviewed = sections.filter((s) => s.status === "REVIEWED").length;
  const editable = canEdit && editState !== "locked";
  return (
    <section aria-label="Proposal" className="grid gap-3">
      <p className="text-[13px] text-muted-foreground" aria-live="polite">
        {reviewed} of {sections.length} sections reviewed. Only reviewed sections count as complete when the bid is checked.
      </p>
      {editState === "withdraws_approval" && canEdit && (
        <p role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[12px]">
          This bid is waiting for approval. Saving a change withdraws the approval and sends the bid back for preparation. When you have finished, press
          <strong className="font-medium"> Prepare bid again</strong> at the top of the page so the bid is checked again and sent for approval afresh.
        </p>
      )}
      {editState === "editable" && canEdit && (
        <p role="note" className="rounded-lg border p-3 text-[12px] text-muted-foreground">
          When you have finished, press <strong className="font-medium text-foreground">Prepare bid again</strong> at the top of the page to check the bid again
          with your changes.
        </p>
      )}
      {editState === "locked" && (
        <p role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[12px]">
          This bid has been approved or closed, so its proposal can no longer be edited.
        </p>
      )}
      {!canEdit && editState !== "locked" && (
        <p className="text-[12px] text-muted-foreground">You can read the proposal. Only owners, admins and operators can change it.</p>
      )}
      <ul className="grid gap-3">
        {sections.map((s) => (
          <li key={`${s.section_key}:${s.version}`}>
            <SectionCard
              tenderId={tenderId}
              section={s}
              history={history.filter((h) => h.ref === s.section_key)}
              requirements={requirements}
              people={people}
              editable={editable}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SectionCard({
  tenderId,
  section: s,
  history,
  requirements,
  people,
  editable,
}: {
  tenderId: string;
  section: SectionView;
  history: HistoryView[];
  requirements: Record<string, string>;
  people: Record<string, string>;
  editable: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [text, setText] = useState(s.content ?? "");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const dirty = text.trim() !== (s.content ?? "").trim();
  const status = STATUS[s.status];

  function run(action: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    setError(null);
    start(async () => {
      const r = await action();
      if (!r.ok) {
        setError(r.error ?? "Something went wrong");
        toast.error(r.error ?? "Something went wrong");
        return;
      }
      toast.success(done);
      router.refresh();
    });
  }

  return (
    <article aria-labelledby={`${id}-title`} className="grid gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${id}-title`} className="text-[13px] font-semibold">
          {s.title}
        </h3>
        <Badge variant={status.variant}>
          {s.status === "REVIEWED" ? (
            <CheckCircle2 aria-hidden />
          ) : s.status === "MISSING_INFORMATION" ? (
            <FileWarning aria-hidden />
          ) : (
            <CircleAlert aria-hidden />
          )}
          {status.label}
        </Badge>
        {s.ai_generated && (
          <Badge variant="violet">
            <Bot aria-hidden /> AI-generated draft
          </Badge>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">Version {s.version}</span>
      </div>

      <div className="grid gap-1">
        <label htmlFor={`${id}-text`} className="text-[12px] text-muted-foreground">
          Text of {s.title}
        </label>
        <Textarea
          id={`${id}-text`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={Math.min(14, Math.max(4, text.split("\n").length + 2))}
          maxLength={20000}
          readOnly={!editable}
          disabled={busy}
          aria-describedby={`${id}-help`}
          placeholder={editable ? "Write this section here." : undefined}
        />
        <p id={`${id}-help`} className="text-[11px] text-muted-foreground">
          {s.ai_generated
            ? "Written by the AI from your company facts and the tender's requirements. Read every sentence before you rely on it. "
            : s.edited_by
              ? `Written by ${who(people, s.edited_by)}${s.edited_at ? `, ${formatDateTime(s.edited_at)}` : ""}. `
              : ""}
          {s.reviewed_at && `Reviewed by ${who(people, s.reviewed_by)}, ${formatDateTime(s.reviewed_at)}. `}
          {text.length.toLocaleString("en-ZA")} of 20 000 characters.
        </p>
      </div>

      {s.needs.length > 0 && s.status !== "REVIEWED" && (
        <p className="text-[12px] text-muted-foreground">
          <span className="font-medium text-foreground">Still needs:</span> {s.needs.join("; ")}
        </p>
      )}
      {s.warnings.length > 0 && (
        <ul className="list-disc pl-5 text-[12px] text-amber-300">
          {s.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {(s.requirement_ids.length > 0 || s.fact_ids.length > 0) && (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-muted-foreground">
            Based on {s.requirement_ids.length + s.fact_ids.length} source{s.requirement_ids.length + s.fact_ids.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {s.requirement_ids.map((r) => (
              <li key={r}>Tender requirement: {requirements[r] ? requirements[r].slice(0, 200) : r}</li>
            ))}
            {s.fact_ids.map((f) => (
              <li key={f}>Company fact: {f.replace(/^(fact|doc):/, "").replaceAll("_", " ")}</li>
            ))}
          </ul>
        </details>
      )}

      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy || !dirty}
            aria-label={`Save ${s.title}`}
            onClick={() => run(() => saveProposalSection(tenderId, s.section_key, text, s.version), "Section saved")}
          >
            Save text
          </Button>
          {s.status !== "REVIEWED" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || dirty || s.status !== "DRAFT"}
              aria-label={`Mark ${s.title} as reviewed`}
              onClick={() => run(() => setSectionReviewed(tenderId, s.section_key, true, s.version), "Section marked as reviewed")}
            >
              Mark as reviewed
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              aria-label={`Take back the review of ${s.title}`}
              onClick={() => run(() => setSectionReviewed(tenderId, s.section_key, false, s.version), "Review taken back")}
            >
              Take back review
            </Button>
          )}
          {dirty && <span className="text-[11px] text-muted-foreground">Save before marking as reviewed.</span>}
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-[12px]">
          {error}
        </p>
      )}
      {history.length > 0 && (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-muted-foreground">History ({history.length})</summary>
          <ol className="mt-1 grid gap-0.5 text-muted-foreground">
            {history.map((h) => (
              <li key={`${h.version}:${h.change}:${h.changed_at}`}>
                Version {h.version}: {CHANGE[h.change] ?? h.change.toLowerCase()} by {who(people, h.changed_by)}, {formatDateTime(h.changed_at)}
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}
