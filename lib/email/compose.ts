import "server-only";

import MailComposer from "nodemailer/lib/mail-composer";

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutgoingEmail {
  from: { address: string; name?: string | null };
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  attachments: OutgoingAttachment[];
}

/** Gmail accepts 25 MB per message after encoding; SMTP servers commonly cap near 20-25 MB. */
export const MAX_EMAIL_ATTACHMENT_BYTES = 18 * 1024 * 1024;

export function nodemailerMessage(m: OutgoingEmail) {
  return {
    from: m.from.name ? { name: m.from.name, address: m.from.address } : m.from.address,
    to: m.to,
    replyTo: m.replyTo,
    subject: m.subject,
    text: m.text,
    attachments: m.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
  };
}

/** Builds the RFC 5322 message (with attachments) that the Gmail API sends as-is. */
export async function buildRawMessage(m: OutgoingEmail): Promise<Buffer> {
  return new MailComposer(nodemailerMessage(m)).compile().build();
}
