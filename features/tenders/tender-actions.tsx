"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Play, RotateCcw, Square, Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { canTransition, USER_SETTABLE_STATUSES, type TenderStatus } from "@/lib/domain/tender-state";
import { humanize } from "@/lib/format";
import { cancelWorkflow, rerunBid, startWorkflow, transitionTender } from "./actions";

const STEPS = ["intake", "analysis", "qualification", "compliance", "proposal", "pricing", "qa", "submission"];

export function TenderActions({
  tenderId,
  status,
  isSimulation,
  activeRunId,
  activeRunStatus = null,
  simulationEnabled,
  killSwitch,
}: {
  tenderId: string;
  status: TenderStatus;
  isSimulation: boolean;
  activeRunId: string | null;
  /** Status of the active run, if any; a BLOCKED run can be replaced by preparing the bid again. */
  activeRunStatus?: string | null;
  simulationEnabled: boolean;
  killSwitch: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [startOpen, setStartOpen] = useState(false);
  const [failStep, setFailStep] = useState("");
  const [failTimes, setFailTimes] = useState(1);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [reason, setReason] = useState("");
  const allowed = USER_SETTABLE_STATUSES.filter((s) => canTransition(status, s));
  const [target, setTarget] = useState<string>(allowed[0] ?? "");

  const canStart = !activeRunId && status === "DISCOVERED" && (!isSimulation || simulationEnabled) && !killSwitch;
  const startHint = activeRunId
    ? "A workflow is already running"
    : status !== "DISCOVERED"
      ? "Workflows start from Discovered"
      : isSimulation && !simulationEnabled
        ? "Simulation workflows are disabled"
        : killSwitch
          ? "Kill switch is engaged"
          : undefined;

  // After the approver sent the bid back, or QA failed it, the bid can be prepared again.
  const canRerun = (status === "PREPARING_BID" || status === "QA_FAILED") && (!activeRunId || activeRunStatus === "BLOCKED") && !killSwitch;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canRerun && (
        <Button
          size="sm"
          disabled={pending}
          title="Runs compliance again with your current documents, then proposal, pricing and QA, and asks for approval again"
          onClick={() =>
            start(async () => {
              const r = await rerunBid(tenderId);
              if (r.ok) {
                toast.success("Bid preparation restarted");
                router.refresh();
              } else toast.error(r.error);
            })
          }
        >
          <RotateCcw /> Prepare bid again
        </Button>
      )}
      {/* Only a newly discovered tender can start a workflow; elsewhere the button would be noise. */}
      {status === "DISCOVERED" && (
        <Dialog open={startOpen} onOpenChange={setStartOpen}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={!canStart || pending} title={startHint}>
              <Play /> {isSimulation ? "Start simulated workflow" : "Send to the agents"}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{isSimulation ? "Start the simulated bid workflow" : "Send this tender to the agents"}</DialogTitle>
              <DialogDescription>
                {isSimulation
                  ? "Nine steps run in order: intake, analysis, qualification, compliance, proposal, pricing, QA, your approval, and a simulated submission. No AI calls are made and nothing is sent outside TenderOS."
                  : "The agents run intake, analysis, qualification, compliance, proposal, pricing and QA, then ask for your approval. TenderOS never submits a bid: once approved you get the pack and delivery instructions."}
              </DialogDescription>
            </DialogHeader>
            <details className={isSimulation ? "rounded-lg border p-3 text-sm" : "hidden"}>
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Failure testing (optional)</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="fail-step">Make this step fail</Label>
                  <NativeSelect id="fail-step" value={failStep} onChange={(e) => setFailStep(e.target.value)}>
                    <option value="">No injected failure</option>
                    {STEPS.map((s) => (
                      <option key={s} value={s}>
                        {humanize(s)}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="fail-times">Number of failures</Label>
                  <Input id="fail-times" type="number" min={1} max={10} value={failTimes} onChange={(e) => setFailTimes(Number(e.target.value) || 1)} />
                </div>
                <p className="text-[11px] text-muted-foreground sm:col-span-2">
                  Up to 3 failures are retried automatically with backoff; more blocks the workflow until you retry.
                </p>
              </div>
            </details>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStartOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await startWorkflow(tenderId, failStep ? { failStep, failTimes } : {});
                    if (r.ok) {
                      toast.success("Workflow started");
                      setStartOpen(false);
                      router.refresh();
                    } else toast.error(r.error);
                  })
                }
              >
                Start
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {activeRunId && (
        <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline">
              <Square /> Cancel workflow
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Cancel this workflow?</DialogTitle>
              <DialogDescription>Queued and waiting tasks are cancelled and pending approvals withdrawn. Completed work is kept.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="cancel-reason">Reason</Label>
              <Textarea id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCancelOpen(false)}>
                Keep running
              </Button>
              <Button
                variant="destructive"
                disabled={pending || reason.trim().length < 3}
                onClick={() =>
                  start(async () => {
                    const r = await cancelWorkflow(activeRunId, reason);
                    if (r.ok) {
                      toast.success("Workflow cancelled");
                      setCancelOpen(false);
                      setReason("");
                      router.refresh();
                    } else toast.error(r.error);
                  })
                }
              >
                Cancel workflow
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {allowed.length > 0 && (
        <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="ghost">
              <Tags /> Change status
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Change tender status</DialogTitle>
              <DialogDescription>Manual changes are limited to outcomes, cancellation and archiving, and are recorded in the audit trail.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="target-status">New status</Label>
                <NativeSelect id="target-status" value={target} onChange={(e) => setTarget(e.target.value)}>
                  {allowed.map((s) => (
                    <option key={s} value={s}>
                      {humanize(s)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="status-reason">Reason</Label>
                <Textarea id="status-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={pending || reason.trim().length < 3 || !target}
                onClick={() =>
                  start(async () => {
                    const r = await transitionTender(tenderId, target, reason);
                    if (r.ok) {
                      toast.success("Status updated");
                      setStatusOpen(false);
                      setReason("");
                      router.refresh();
                    } else toast.error(r.error);
                  })
                }
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
