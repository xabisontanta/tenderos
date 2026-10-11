import { contextFor, nowFor, renderApp, type AppEmail, type AppEmailOptions } from "../app";
import { firstName, formatClosing, formatRemaining, plural, toDate } from "../format";
import type { Block, EmailContent, Rich } from "../layout";

export interface ApprovalNeededInput {
  recipientName?: string | null;
  organisationName: string;
  tenderTitle: string;
  referenceNumber?: string | null;
  buyerName?: string | null;
  closingAt: Date | string;
  /** Where the approver decides (https). */
  approvalUrl: string;
  /** Where the bid goes after approval, as recorded on the tender. */
  submissionDestination?: string | null;
  /** Open issues quality review left on the bid. */
  openIssues?: number;
}

/**
 * Sent to the owners and admins of an organisation when a bid reaches
 * READY_FOR_APPROVAL. Operators and viewers cannot decide, so they do not get it.
 */
export function renderApprovalNeeded(input: ApprovalNeededInput, options: AppEmailOptions): AppEmail {
  const ctx = contextFor(options);
  const now = nowFor(options);
  const closing = toDate(input.closingAt);
  const msLeft = closing.getTime() - now.getTime();
  const closed = msLeft <= 0;
  const name = firstName(input.recipientName);
  const issues = input.openIssues ?? 0;

  const rows: Array<{ label: string; value: Rich }> = [{ label: "Tender", value: { strong: input.tenderTitle } }];
  if (input.referenceNumber) rows.push({ label: "Reference", value: input.referenceNumber });
  if (input.buyerName) rows.push({ label: "Buyer", value: input.buyerName });
  rows.push({ label: "Closes", value: closed ? `${formatClosing(closing)} (closed)` : [{ strong: formatClosing(closing) }, `, ${formatRemaining(msLeft)}`] });
  if (input.submissionDestination) rows.push({ label: "Deliver to", value: input.submissionDestination });

  const notices: Block[] = [];
  if (closed) {
    notices.push({
      type: "notice",
      tone: "danger",
      title: "This tender has closed",
      body: "An approval lapses when the tender closes, so this bid can no longer be approved. Open it to see where it stands.",
    });
  } else {
    if (issues > 0) {
      notices.push({
        type: "notice",
        tone: "warning",
        title: `${plural(issues, "open issue")} from quality review`,
        body: "Read them on the approval page before you decide. Approving does not close them.",
      });
    }
    notices.push({
      type: "notice",
      tone: "info",
      title: "Nothing is sent until you approve",
      body: `TenderOS never submits a bid itself. After you approve, the bid pack is released for you to send from your own mailbox or deliver by hand. The approval lapses when the tender closes, so decide before ${formatClosing(closing)}.`,
    });
  }

  const content: EmailContent = {
    title: `Approval needed: ${input.tenderTitle}`,
    preheader: closed ? `${input.tenderTitle} has closed.` : `${input.tenderTitle} closes ${formatRemaining(msLeft)}. Your decision is needed.`,
    eyebrow: { label: "Approval needed", icon: "clipboard-check" },
    headline: closed ? "This bid can no longer be approved" : "A bid is waiting for your approval",
    blocks: [
      ...(name ? [{ type: "p", text: `Hi ${name},`, tight: true } as const] : []),
      {
        type: "p",
        text: [
          "The bid for ",
          { strong: input.tenderTitle },
          " has been through quality review and is waiting for an owner or admin of ",
          { strong: input.organisationName },
          " to approve or reject it.",
        ],
      },
      { type: "details", rows },
      ...notices,
      { type: "button", label: closed ? "View the bid" : "Review and decide", href: input.approvalUrl },
    ],
    reason: `you are an owner or admin of ${input.organisationName} on TenderOS`,
  };
  return renderApp(content, `Approval needed: ${input.tenderTitle}`, ctx);
}
