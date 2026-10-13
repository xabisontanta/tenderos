"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { canAdminister, requireContext } from "@/lib/data/context";
import { requireAal2 } from "@/lib/auth/require-aal2";
import { rateLimit, toUserError, type ActionResult } from "@/lib/actions";
import { DOCUMENT_BUCKET } from "@/lib/domain/documents";
import { MAX_EMAIL_ATTACHMENT_BYTES, type OutgoingAttachment } from "@/lib/email/compose";
import { reserveBidEmail, settleBidEmail } from "@/lib/email/deliver";
import { googleConfig, sendWithGmail } from "@/lib/email/gmail";
import { SMTP_PORTS } from "@/lib/email/network";
import { sendWithSmtp, verifySmtp } from "@/lib/email/smtp";
import { createLogger } from "@/lib/log";

const log = createLogger({ service: "web.email" });

const email = z.string().trim().toLowerCase().email("Enter a valid email address").max(254);

const smtpSchema = z.object({
  fromAddress: email,
  displayName: z.string().trim().max(120).optional(),
  host: z.string().trim().toLowerCase().min(3).max(253),
  port: z.coerce.number().refine((p) => (SMTP_PORTS as readonly number[]).includes(p), "Use port 465, 587 or 2525"),
  username: z.string().trim().min(1, "Enter the mailbox username").max(254),
  password: z.string().min(1, "Enter the mailbox password").max(1024),
});

/** Saves a company mailbox after signing in to its SMTP server once. */
export async function connectSmtp(input: z.input<typeof smtpSchema>): Promise<ActionResult> {
  const ctx = await requireContext();
  if (!canAdminister(ctx.role)) return { ok: false, error: "Only owners and admins can connect a mailbox" };
  const verify = await requireAal2(ctx);
  if (verify) return { ok: false, error: verify };
  const parsed = smtpSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const d = parsed.data;
  const supabase = await getServerSupabase();
  const limited = await rateLimit(supabase, "email.verify", 10, 3600);
  if (limited) return { ok: false, error: limited };
  try {
    await verifySmtp({ host: d.host, port: d.port, username: d.username, password: d.password });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const { error } = await supabase.rpc("connect_email_account", {
    p_org: ctx.organisation.id,
    p_provider: "SMTP",
    p_from: d.fromAddress,
    p_display_name: d.displayName ?? "",
    p_secret: JSON.stringify({ password: d.password }),
    p_smtp_host: d.host,
    p_smtp_port: d.port,
    p_smtp_username: d.username,
  });
  if (error) return { ok: false, error: toUserError(error, "Could not save the mailbox") };
  revalidatePath("/settings");
  return { ok: true };
}

export async function disconnectEmail(id: string): Promise<ActionResult> {
  await requireContext();
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Invalid mailbox" };
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("disconnect_email_account", { p_id: id });
  if (error) return { ok: false, error: toUserError(error, "Could not disconnect the mailbox") };
  revalidatePath("/settings");
  return { ok: true };
}

const sendSchema = z.object({
  submissionId: z.string().uuid(),
  accountId: z.string().uuid("Choose the mailbox to send from"),
  to: email,
  subject: z
    .string()
    .trim()
    .min(3, "Add a subject")
    .max(300)
    .regex(/^[^\r\n]*$/, "Keep the subject on one line"),
  body: z.string().trim().min(10, "Write a short covering message").max(20_000),
  documentIds: z.array(z.string().uuid()).max(30),
});

/**
 * Sends an approved bid by email from the member's own mailbox, then records
 * the delivery. Only an owner or admin can send, only after the bid was
 * approved, and only from a mailbox they connected themselves.
 */
export async function sendBidEmail(input: z.input<typeof sendSchema>): Promise<ActionResult> {
  const ctx = await requireContext();
  if (!canAdminister(ctx.role)) return { ok: false, error: "Only owners and admins can send a bid" };
  const verify = await requireAal2(ctx);
  if (verify) return { ok: false, error: verify };
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const d = parsed.data;
  const supabase = await getServerSupabase();
  const limited = await rateLimit(supabase, "bid.send_email", 10, 3600);
  if (limited) return { ok: false, error: limited };

  const { data: sub } = await supabase
    .from("submission_records")
    .select("id, organisation_id, tender_id, status, is_simulation, approval_id")
    .eq("id", d.submissionId)
    .eq("organisation_id", ctx.organisation.id)
    .maybeSingle();
  if (!sub) return { ok: false, error: "Submission not found" };
  if (sub.is_simulation) return { ok: false, error: "Simulated bids are never emailed" };
  if (sub.status !== "ACTION_REQUIRED") return { ok: false, error: "This bid is already recorded as delivered" };
  const { data: approval } = await supabase.from("approvals").select("status").eq("id", sub.approval_id).single();
  if (approval?.status !== "APPROVED") return { ok: false, error: "The bid has not been approved" };

  const admin = getAdminSupabase();
  const { data: creds, error: credError } = await admin.rpc("email_account_credential", { p_id: d.accountId, p_user: ctx.userId });
  const cred = creds?.[0];
  if (credError || !cred || cred.organisation_id !== ctx.organisation.id) return { ok: false, error: "Choose a mailbox you connected yourself" };

  // Attachments: only this organisation's live documents, read with the member's own access. Their
  // details are checked now; the files are read after the send is reserved.
  let docs: Array<{ id: string; file_name: string; mime_type: string | null; storage_path: string; size_bytes: number | null }> = [];
  if (d.documentIds.length) {
    const { data } = await supabase
      .from("company_documents")
      .select("id, file_name, mime_type, storage_path, size_bytes")
      .eq("organisation_id", ctx.organisation.id)
      .is("archived_at", null)
      .in("id", d.documentIds);
    docs = data ?? [];
    if (docs.length !== d.documentIds.length) return { ok: false, error: "A selected document is no longer available" };
    const total = docs.reduce((n, x) => n + (x.size_bytes ?? 0), 0);
    if (total > MAX_EMAIL_ATTACHMENT_BYTES)
      return { ok: false, error: "The attachments are larger than 18 MB together; deselect some or deliver the bid another way" };
  }

  // Reserve the send before anything is mailed. The database allows one SENDING or SENT message per bid,
  // so of two simultaneous presses of Send only one gets past here.
  const reservation = await reserveBidEmail(admin, {
    organisationId: ctx.organisation.id,
    accountId: d.accountId,
    tenderId: sub.tender_id,
    submissionId: sub.id,
    sentBy: ctx.userId,
    from: cred.from_address,
    to: d.to,
    subject: d.subject,
  });
  if (!reservation.ok) {
    if (reservation.failed) {
      log.error("bid email not reserved", { organisation_id: ctx.organisation.id, submission_id: sub.id, error: reservation.error });
      return { ok: false, error: "Could not start the send. Nothing was emailed; try again in a moment." };
    }
    return { ok: false, error: reservation.error };
  }

  const attachments: OutgoingAttachment[] = [];
  let messageId: string | null = null;
  let failure: string | null = null;
  try {
    for (const doc of docs) {
      const { data: blob, error } = await supabase.storage.from(DOCUMENT_BUCKET).download(doc.storage_path);
      if (error || !blob) throw new Error(`Could not read ${doc.file_name}`);
      attachments.push({ filename: doc.file_name, contentType: doc.mime_type ?? "application/octet-stream", content: Buffer.from(await blob.arrayBuffer()) });
    }
    const message = {
      from: { address: cred.from_address, name: cred.display_name },
      to: d.to,
      replyTo: cred.from_address,
      subject: d.subject,
      text: d.body,
      attachments,
    };
    const secret = JSON.parse(cred.secret) as { password?: string; refresh_token?: string };
    if (cred.provider === "GMAIL") {
      const g = googleConfig();
      if (!g || !secret.refresh_token) throw new Error("Gmail sending is not configured on this server");
      messageId = (await sendWithGmail(g, secret.refresh_token, message)).messageId;
    } else {
      messageId = (
        await sendWithSmtp({ host: cred.smtp_host!, port: cred.smtp_port!, username: cred.smtp_username!, password: secret.password ?? "" }, message)
      ).messageId;
    }
  } catch (err) {
    failure = (err as Error).message.slice(0, 500);
    log.warn("bid email failed", { organisation_id: ctx.organisation.id, submission_id: sub.id, provider: cred.provider });
  }

  // Close the reservation. If this fails after a successful send, the row stays SENDING and keeps
  // blocking a second send; the person is told so.
  const sizes = attachments.map((a) => ({ filename: a.filename, bytes: a.content.length }));
  const settleError = await settleBidEmail(
    admin,
    reservation.id,
    failure ? { ok: false, error: failure, attachments: sizes } : { ok: true, messageId, attachments: sizes },
  );
  if (settleError) {
    log.error("bid email record not saved", {
      organisation_id: ctx.organisation.id,
      submission_id: sub.id,
      message_id: reservation.id,
      sent: !failure,
      error: settleError,
    });
  }
  const { error: accountError } = await admin
    .from("email_accounts")
    .update(failure ? { status: "ERROR", last_error: failure } : { status: "ACTIVE", last_error: null, last_used_at: new Date().toISOString() })
    .eq("id", d.accountId);
  if (accountError) {
    log.error("mailbox status not updated", { organisation_id: ctx.organisation.id, account_id: d.accountId, error: accountError.message });
  }
  if (failure) return { ok: false, error: failure };
  if (settleError) {
    return {
      ok: false,
      error:
        "The email was sent, but TenderOS could not save the record of it. Do not send it again: check the mailbox's Sent folder, then press Record as delivered.",
    };
  }

  const { error: recordError } = await supabase.rpc("record_bid_delivery", {
    p_submission_id: sub.id,
    p_reference: messageId ?? undefined,
    p_note: `Emailed to ${d.to} from ${cred.from_address} with ${attachments.length} attachment(s)`,
  });
  revalidatePath(`/tenders/${sub.tender_id}`);
  if (recordError) return { ok: false, error: `The email was sent, but recording the delivery failed: ${toUserError(recordError)}` };
  return { ok: true };
}

const deliverySchema = z.object({
  submissionId: z.string().uuid(),
  reference: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).optional(),
});

/** Records that a person delivered the approved bid by hand or on the portal. */
export async function recordDelivery(input: z.input<typeof deliverySchema>): Promise<ActionResult> {
  const ctx = await requireContext();
  if (!canAdminister(ctx.role)) return { ok: false, error: "Only owners and admins can record a delivery" };
  const parsed = deliverySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const supabase = await getServerSupabase();
  const { data: sub } = await supabase.from("submission_records").select("tender_id").eq("id", parsed.data.submissionId).maybeSingle();
  const { error } = await supabase.rpc("record_bid_delivery", {
    p_submission_id: parsed.data.submissionId,
    p_reference: parsed.data.reference || undefined,
    p_note: parsed.data.note || undefined,
  });
  if (error) return { ok: false, error: toUserError(error, "Could not record the delivery") };
  if (sub) revalidatePath(`/tenders/${sub.tender_id}`);
  return { ok: true };
}
