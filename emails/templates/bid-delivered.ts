import { bareMessageId, firstName, formatBytes, formatClosing } from "../format";
import { contextFor, renderApp, type AppEmail, type AppEmailOptions } from "../app";
import type { Block, EmailContent, Inline } from "../layout";

export interface BidDeliveredInput {
  recipientName?: string | null;
  organisationName: string;
  tenderTitle: string;
  referenceNumber?: string | null;
  buyerName?: string | null;
  /** EMAIL: sent from a connected mailbox. MANUAL: a person recorded a hand or portal delivery. */
  method: "EMAIL" | "MANUAL";
  /** Who sent it, or who recorded it. */
  deliveredBy: string;
  deliveredAt: Date | string;
  deliveredTo?: string | null;
  fromAddress?: string | null;
  attachments?: ReadonlyArray<{ filename: string; bytes: number }>;
  /** The mail server's message id, kept as the delivery reference. */
  providerReference?: string | null;
  tenderUrl: string;
}

/** Confirms that a delivery was recorded (record_bid_delivery). It says what TenderOS knows, and no more. */
export function renderBidDelivered(input: BidDeliveredInput, options: AppEmailOptions): AppEmail {
  const ctx = contextFor(options);
  const name = firstName(input.recipientName);
  const email = input.method === "EMAIL";

  const intro: Inline[] = email
    ? [
        { strong: input.deliveredBy },
        " emailed the approved bid for ",
        { strong: input.tenderTitle },
        ...(input.deliveredTo ? [" to ", { strong: input.deliveredTo }] : []),
        ...(input.fromAddress ? [` from ${input.fromAddress}`] : []),
        ". TenderOS has recorded the delivery.",
      ]
    : [{ strong: input.deliveredBy }, " recorded that the approved bid was delivered by hand or on the buyer's portal. TenderOS has recorded the delivery."];

  const rows: Array<{ label: string; value: Inline | readonly Inline[] }> = [{ label: "Tender", value: { strong: input.tenderTitle } }];
  if (input.referenceNumber) rows.push({ label: "Reference", value: input.referenceNumber });
  if (input.buyerName) rows.push({ label: "Buyer", value: input.buyerName });
  if (email && input.deliveredTo) rows.push({ label: "Delivered to", value: { strong: input.deliveredTo } });
  if (email && input.fromAddress) rows.push({ label: "Sent from", value: input.fromAddress });
  rows.push({ label: input.method === "EMAIL" ? "Sent by" : "Recorded by", value: input.deliveredBy });
  rows.push({ label: "When", value: formatClosing(input.deliveredAt) });
  if (input.providerReference) rows.push({ label: "Message ID", value: { code: bareMessageId(input.providerReference) } });

  const attachments = input.attachments ?? [];
  const blocks: Block[] = [
    ...(name ? [{ type: "p", text: `Hi ${name},`, tight: true } as const] : []),
    { type: "p", text: intro },
    { type: "details", rows },
  ];
  if (attachments.length) {
    blocks.push({ type: "p", muted: true, text: [{ strong: `Attached (${attachments.length})` }] });
    blocks.push({ type: "list", items: attachments.map((a) => `${a.filename} · ${formatBytes(a.bytes)}`) });
  }
  blocks.push(
    email
      ? {
          type: "notice",
          tone: "info",
          title: "What this record shows",
          body: "TenderOS records that the mailbox accepted the message. It cannot see whether the buyer's server delivered it. If the tender asks for proof of receipt, ask the buyer to confirm.",
        }
      : {
          type: "notice",
          tone: "info",
          title: "Keep your proof",
          body: "Keep the portal receipt or the signed delivery note with the bid pack. TenderOS holds your record, not the buyer's acknowledgement.",
        },
    { type: "button", label: "View the delivery record", href: input.tenderUrl },
  );

  const content: EmailContent = {
    title: `Bid delivered: ${input.tenderTitle}`,
    preheader: email ? `${input.tenderTitle} was emailed${input.deliveredTo ? ` to ${input.deliveredTo}` : ""}. The delivery is recorded.` : `Delivery of ${input.tenderTitle} is recorded.`,
    eyebrow: { label: "Bid delivered", icon: "send" },
    headline: "Bid delivered",
    blocks,
    reason: `you belong to ${input.organisationName} on TenderOS and a bid delivery was recorded`,
  };
  return renderApp(content, `Bid delivered: ${input.tenderTitle}`, ctx);
}
