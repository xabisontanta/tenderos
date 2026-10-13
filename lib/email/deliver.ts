import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * The bookkeeping around emailing an approved bid, kept apart from the mail server so it can be tested.
 *
 * Reserve first, send second, settle third. The reservation is a message row in state SENDING; the
 * partial unique index `email_messages_one_live_send_uq` allows one SENDING or SENT row per submission,
 * so of two simultaneous sends exactly one reserves, and the other is refused before any mail leaves.
 */
type Admin = SupabaseClient<Database>;

export interface BidEmailReservation {
  organisationId: string;
  accountId: string;
  tenderId: string;
  submissionId: string;
  sentBy: string;
  from: string;
  to: string;
  subject: string;
}

export type Reserved =
  { ok: true; id: string } | { ok: false; error: string; /** The database failed; nothing is known about other sends. */ failed?: boolean };

export const ALREADY_EMAILED = "This bid was already emailed; record the delivery instead of sending it again";
export const SEND_IN_PROGRESS =
  "This bid is being emailed right now, or an earlier attempt did not finish. Check the mailbox's Sent folder: if the email went out, press Record as delivered and do not send it again.";

/** Claims the send. Fails, without mailing anything, when another SENDING or SENT message exists for the bid. */
export async function reserveBidEmail(admin: Admin, r: BidEmailReservation): Promise<Reserved> {
  const { data, error } = await admin
    .from("email_messages")
    .insert({
      organisation_id: r.organisationId,
      email_account_id: r.accountId,
      tender_id: r.tenderId,
      submission_record_id: r.submissionId,
      sent_by: r.sentBy,
      from_address: r.from,
      to_address: r.to,
      subject: r.subject,
      attachments: [],
      status: "SENDING",
    })
    .select("id")
    .single();
  if (!error && data) return { ok: true, id: data.id };
  if (error?.code === "23505") {
    const { data: live } = await admin
      .from("email_messages")
      .select("status")
      .eq("submission_record_id", r.submissionId)
      .in("status", ["SENDING", "SENT"])
      .limit(1)
      .maybeSingle();
    return { ok: false, error: live?.status === "SENT" ? ALREADY_EMAILED : SEND_IN_PROGRESS };
  }
  return { ok: false, failed: true, error: error?.message ?? "no row returned" };
}

export type Outcome =
  | { ok: true; messageId: string | null; attachments: Array<{ filename: string; bytes: number }> }
  | { ok: false; error: string; attachments?: Array<{ filename: string; bytes: number }> };

/** Marks the reservation SENT or FAILED. Returns a description of what went wrong, or null. */
export async function settleBidEmail(admin: Admin, id: string, outcome: Outcome): Promise<string | null> {
  const patch = outcome.ok
    ? { status: "SENT", provider_message_id: outcome.messageId, error: null, attachments: outcome.attachments }
    : { status: "FAILED", error: outcome.error.slice(0, 500), ...(outcome.attachments ? { attachments: outcome.attachments } : {}) };
  const { data, error } = await admin.from("email_messages").update(patch).eq("id", id).eq("status", "SENDING").select("id");
  if (error) return error.message;
  if (!data?.length) return "the reserved message was not found in state SENDING";
  return null;
}
