import type { AgentExecutor } from "@/agents/runtime/types";
import { NonRetryableError } from "@/agents/runtime/types";
import { SIMULATED_COST, simulateWork } from "@/agents/runtime/simulation";
import { packageHash } from "./logic";
import { submissionOutputSchema, type SubmissionOutput } from "./schema";

/**
 * Submission Agent (simulation). Performs every pre-submission verification,
 * then records a simulated submission. Nothing is sent externally. Physical
 * submissions become a user action item; they are never marked as delivered.
 */
export const submissionExecute: AgentExecutor<SubmissionOutput> = {
  taskType: "submission.execute",
  agent: "submission",
  requires: ["PUBLIC_TENDER_DATA", "SUBMISSION"],
  outputSchema: submissionOutputSchema,
  async run(ctx) {
    const t = ctx.tender;
    if (!t) throw new NonRetryableError("Tender data unavailable");
    const approved = ctx.task.input.approval_status === "APPROVED";
    if (!approved) throw new NonRetryableError("Submission attempted without a granted approval");
    if (new Date(t.closing_at).getTime() <= ctx.now.getTime()) {
      throw new NonRetryableError("Closing date has passed; submission not attempted");
    }
    await simulateWork(ctx, ["Verifying approval and deadline", "Hashing bid package", "Recording submission"]);
    const hash = packageHash(ctx.previousOutputs);

    // Real tenders: TenderOS never submits on anyone's behalf. It hands over a
    // verified pack and tells the person exactly where and by when to deliver.
    if (!ctx.workflow.isSimulation) {
      const where =
        t.submission_method === "ELECTRONIC_PORTAL"
          ? "upload it on eTenders (eSubmission)"
          : t.submission_destination
            ? `deliver it to ${t.submission_destination}`
            : "deliver it as the tender documents instruct";
      return {
        output: {
          status: "ACTION_REQUIRED",
          method: t.submission_method,
          package_hash: hash,
          destination: t.submission_destination,
          verified: { approval: true, deadline: true, reference: Boolean(t.reference_number) },
          simulated: false,
          receipt_note: `Bid pack approved. Sign the declarations, ${where} before ${t.closing_at}, then record the receipt.`,
        },
        summary: "Approved bid pack ready for delivery",
        events: [
          { type: "SUBMISSION_STARTED", summary: "Submission checks passed" },
          { type: "SUBMISSION_FAILED", severity: "WARNING", summary: "Bid pack ready: a person must sign and deliver it", payload: { action_required: true } },
        ],
        cost: SIMULATED_COST,
      };
    }

    const physical = t.submission_method === "PHYSICAL";
    return {
      output: {
        status: physical ? "ACTION_REQUIRED" : "SUBMITTED",
        method: t.submission_method,
        package_hash: hash,
        destination: t.submission_destination,
        verified: { approval: true, deadline: true, reference: Boolean(t.reference_number) },
        simulated: true,
        receipt_note: physical
          ? "Physical submission required: a person must deliver the bid and record the receipt"
          : "Simulated submission: no bid was sent to any external portal or mailbox",
      },
      summary: physical ? "Physical submission action item created" : "Simulated submission recorded (nothing sent externally)",
      events: [
        { type: "SUBMISSION_STARTED", summary: "Submission checks passed" },
        physical
          ? { type: "SUBMISSION_FAILED", severity: "WARNING", summary: "Physical submission needs a person to deliver it", payload: { action_required: true } }
          : { type: "SUBMISSION_COMPLETED", summary: "Simulated submission completed", payload: { simulated: true, package_hash: hash } },
      ],
      cost: SIMULATED_COST,
    };
  },
};
