"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { JsonView } from "@/components/command-centre/json-view";
import { formatDateTime, humanize, relativeTime } from "@/lib/format";
import { decideApproval } from "./actions";

export interface PendingApproval {
  id: string;
  type: string;
  summary: string;
  risk_level: string;
  payload: unknown;
  requested_at: string;
  expires_at: string | null;
  tenders: { id: string; title: string; reference_number: string | null; closing_at: string | null } | null;
}

const RISK: Record<string, string> = {
  LOW: "border-emerald-500/30 text-emerald-300",
  MEDIUM: "border-amber-500/30 text-amber-300",
  HIGH: "border-orange-500/40 text-orange-300",
  CRITICAL: "border-red-500/40 text-red-300",
};

/** One pending approval. Approve or reject; rejecting requires a reason. Decisions are final and audited. */
export function ApprovalCard({ approval, canDecide }: { approval: PendingApproval; canDecide: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"approve" | "reject" | null>(null);
  const [comments, setComments] = useState("");

  const submit = () =>
    start(async () => {
      const r = await decideApproval({ approvalId: approval.id, approve: mode === "approve", comments });
      if (r.ok) {
        toast.success(mode === "approve" ? "Approved. Submission will proceed." : "Rejected. The workflow is stopped.");
        setMode(null);
        setComments("");
        router.refresh();
      } else toast.error(r.error);
    });

  return (
    <Card className="border-violet-500/30">
      <CardContent className="grid gap-3 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-medium">{humanize(approval.type)}</p>
            {approval.tenders && (
              <Link href={`/tenders/${approval.tenders.id}`} className="text-[13px] text-primary hover:underline">
                {approval.tenders.title}
                {approval.tenders.reference_number ? ` · ${approval.tenders.reference_number}` : ""}
              </Link>
            )}
          </div>
          <Badge variant="outline" className={RISK[approval.risk_level]}>
            {humanize(approval.risk_level)} risk
          </Badge>
        </div>
        <p className="text-[13px] text-muted-foreground">{approval.summary}</p>
        <p className="text-[12px] text-muted-foreground">
          Requested {relativeTime(approval.requested_at)}
          {approval.expires_at && ` · expires ${formatDateTime(approval.expires_at)}`}
          {approval.tenders?.closing_at && ` · tender closes ${formatDateTime(approval.tenders.closing_at)}`}
        </p>
        <details>
          <summary className="cursor-pointer text-[12px] text-muted-foreground hover:text-foreground">What you are approving</summary>
          <JsonView value={approval.payload} className="mt-2 max-h-80" />
        </details>
        {canDecide ? (
          <Dialog open={mode !== null} onOpenChange={(o) => !o && setMode(null)}>
            <div className="flex gap-2">
              <DialogTrigger asChild>
                <Button size="sm" onClick={() => setMode("approve")}>
                  <Check /> Approve
                </Button>
              </DialogTrigger>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline" onClick={() => setMode("reject")}>
                  <X /> Reject
                </Button>
              </DialogTrigger>
            </div>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{mode === "approve" ? "Approve this submission?" : "Reject this submission?"}</DialogTitle>
                <DialogDescription>
                  {mode === "approve"
                    ? "The Submission Agent will package and submit the bid. For a simulated tender nothing leaves the system."
                    : "The workflow stops and the tender is marked as not submitted."}
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-1.5">
                <Label htmlFor={`c-${approval.id}`}>{mode === "reject" ? "Reason (required)" : "Comments (optional)"}</Label>
                <Textarea id={`c-${approval.id}`} value={comments} onChange={(e) => setComments(e.target.value)} maxLength={2000} rows={3} />
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setMode(null)}>
                  Cancel
                </Button>
                <Button
                  variant={mode === "reject" ? "destructive" : "default"}
                  disabled={pending || (mode === "reject" && comments.trim().length < 3)}
                  onClick={submit}
                >
                  {mode === "approve" ? "Approve" : "Reject"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : (
          <p className="text-[12px] text-muted-foreground">Only owners and admins can decide approvals.</p>
        )}
      </CardContent>
    </Card>
  );
}
