import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "@/lib/db/pool";
import type { Worker } from "@/workflows/worker";
import { DOCUMENT_BUCKET } from "@/lib/domain/documents";
import { bootstrapOrg, createTender, createUser, drainOrg, testPool, testWorker, type Client, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  client: null as unknown,
  userId: "",
  orgId: "",
  sent: [] as Array<{ to: string }>,
  failNext: false,
  delayMs: 0,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/context", () => ({
  requireContext: async () => ({ userId: h.userId, organisation: { id: h.orgId }, role: "owner" }),
  canAdminister: (role: string) => role === "owner" || role === "admin",
}));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: async () => h.client }));
vi.mock("@/lib/supabase/admin", async () => {
  const { admin } = await import("./helpers");
  return { getAdminSupabase: () => admin() };
});
// The only fake: the mail server. Everything else is the real database, Vault and RPCs.
vi.mock("@/lib/email/smtp", () => ({
  verifySmtp: vi.fn(),
  sendWithSmtp: async (_settings: unknown, message: { to: string }) => {
    if (h.delayMs) await new Promise((r) => setTimeout(r, h.delayMs));
    if (h.failNext) {
      h.failNext = false;
      throw new Error("535 authentication failed");
    }
    h.sent.push({ to: message.to });
    return { messageId: `<${randomUUID()}@acme.co.za>` };
  },
}));

const { sendBidEmail } = await import("@/features/email/actions");

let pool: Pool;
let worker: Worker;
let owner: TestUser;
let orgId: string;
let accountId: string;

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

/** An approved real bid waiting for a person to deliver it by email. */
async function approvedEmailBid(): Promise<{ submissionId: string; tenderId: string }> {
  const tender = await createTender(owner.client as Client, orgId, {
    is_simulation: false,
    reference_number: `SEND-${randomUUID().slice(0, 8)}`,
    submission_method: "EMAIL",
    submission_destination: "bids@municipality.gov.za",
  });
  const started = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
  expect(started.error).toBeNull();
  await drainOrg(worker, pool, orgId);
  const { data: approval } = await owner.client.from("approvals").select("id").eq("workflow_run_id", started.data!).single();
  expect((await owner.client.rpc("decide_approval", { p_approval_id: approval!.id, p_approve: true, p_comments: "Send it" })).error).toBeNull();
  await drainOrg(worker, pool, orgId);
  const { data: sub } = await owner.client.from("submission_records").select("id, status").eq("workflow_run_id", started.data!).single();
  expect(sub!.status).toBe("ACTION_REQUIRED");
  return { submissionId: sub!.id, tenderId: tender.id };
}

const message = (submissionId: string) => ({
  submissionId,
  accountId,
  to: "bids@municipality.gov.za",
  subject: "Bid submission: SEND test",
  body: "Please find our bid attached. Regards.",
  documentIds: [] as string[],
});

async function messages(submissionId: string) {
  const { rows } = await pool.query<{ status: string; error: string | null }>(
    `select status, error from public.email_messages where submission_record_id = $1 order by created_at`,
    [submissionId],
  );
  return rows;
}

beforeAll(async () => {
  pool = testPool();
  worker = testWorker(pool);
  owner = await createUser("send-owner");
  orgId = await bootstrapOrg(owner);
  h.client = owner.client;
  h.userId = owner.id;
  h.orgId = orgId;

  for (const [type, title, expires] of [
    ["cipc_registration", "CIPC CoR 14.3", undefined],
    ["csd_registration", "CSD summary", undefined],
    ["tax_compliance", "TCS PIN letter", inDays(200)],
    ["sbd_declarations", "SBD 4 and 6.1", undefined],
  ] as const) {
    const path = `${orgId}/${type}/doc.pdf`;
    const up = await owner.client.storage
      .from(DOCUMENT_BUCKET)
      .upload(path, new Blob(["%PDF-1.4\n"], { type: "application/pdf" }), { contentType: "application/pdf" });
    expect(up.error).toBeNull();
    expect(
      (await owner.client.rpc("register_company_document", { p_org: orgId, p_doc_type: type, p_title: title, p_path: path, p_expires_at: expires })).error,
    ).toBeNull();
  }
  await owner.client.from("company_profiles").insert({ organisation_id: orgId, legal_name: "Acme Trading (Pty) Ltd", bbbee_level: 2 });

  const mailbox = await owner.client.rpc("connect_email_account", {
    p_org: orgId,
    p_provider: "SMTP",
    p_from: "bids@acme.co.za",
    p_display_name: "Acme Tenders",
    p_secret: JSON.stringify({ password: "app-password-123" }),
    p_smtp_host: "smtp.acme.co.za",
    p_smtp_port: 587,
    p_smtp_username: "bids@acme.co.za",
  });
  expect(mailbox.error).toBeNull();
  accountId = mailbox.data as unknown as string;
});

afterAll(async () => {
  await pool.end();
});

describe("sending a bid by email", () => {
  it("two simultaneous presses of Send produce exactly one email and one message", async () => {
    const bid = await approvedEmailBid();
    h.sent.length = 0;
    h.delayMs = 250; // long enough that both calls are past their checks before either finishes
    const [a, b] = await Promise.all([sendBidEmail(message(bid.submissionId)), sendBidEmail(message(bid.submissionId))]);
    h.delayMs = 0;

    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(h.sent).toHaveLength(1);
    expect(await messages(bid.submissionId)).toEqual([{ status: "SENT", error: null }]);
    const { data: sub } = await owner.client.from("submission_records").select("status").eq("id", bid.submissionId).single();
    expect(sub!.status).toBe("SUBMITTED");
    const refused = [a, b].find((r) => !r.ok) as { ok: false; error: string };
    expect(refused.error).toMatch(/being emailed|already/i);
  });

  it("lets a person try again after a failed send, and keeps the failed attempt on record", async () => {
    const bid = await approvedEmailBid();
    h.sent.length = 0;
    h.failNext = true;
    const first = await sendBidEmail(message(bid.submissionId));
    expect(first).toEqual({ ok: false, error: "535 authentication failed" });
    expect(await messages(bid.submissionId)).toEqual([{ status: "FAILED", error: "535 authentication failed" }]);

    const second = await sendBidEmail(message(bid.submissionId));
    expect(second).toEqual({ ok: true });
    expect(h.sent).toHaveLength(1);
    expect((await messages(bid.submissionId)).map((m) => m.status)).toEqual(["FAILED", "SENT"]);
  });

  it("refuses to send again once the bid was emailed", async () => {
    const bid = await approvedEmailBid();
    h.sent.length = 0;
    expect(await sendBidEmail(message(bid.submissionId))).toEqual({ ok: true });
    const again = await sendBidEmail(message(bid.submissionId));
    expect(again.ok).toBe(false);
    expect(h.sent).toHaveLength(1);
  });
});

describe("the database guard behind it", () => {
  async function insertMessage(submissionId: string, tenderId: string, status: string) {
    return pool.query(
      `insert into public.email_messages (organisation_id, email_account_id, tender_id, submission_record_id, sent_by, from_address, to_address, subject, status)
       values ($1, $2, $3, $4, $5, 'bids@acme.co.za', 'bids@municipality.gov.za', 'Bid', $6)`,
      [orgId, accountId, tenderId, submissionId, owner.id, status],
    );
  }

  it("allows only one SENDING or SENT message per submission, however it is inserted", async () => {
    const bid = await approvedEmailBid();
    await insertMessage(bid.submissionId, bid.tenderId, "SENDING");
    await expect(insertMessage(bid.submissionId, bid.tenderId, "SENDING")).rejects.toThrow(/duplicate key|unique/i);
    await expect(insertMessage(bid.submissionId, bid.tenderId, "SENT")).rejects.toThrow(/duplicate key|unique/i);
    // Failed attempts do not count, and several may be kept.
    await insertMessage(bid.submissionId, bid.tenderId, "FAILED");
    await insertMessage(bid.submissionId, bid.tenderId, "FAILED");
    await pool.query(`update public.email_messages set status = 'SENT' where submission_record_id = $1 and status = 'SENDING'`, [bid.submissionId]);
    await expect(insertMessage(bid.submissionId, bid.tenderId, "SENDING")).rejects.toThrow(/duplicate key|unique/i);
  });

  it("accepts only known statuses", async () => {
    const bid = await approvedEmailBid();
    await expect(insertMessage(bid.submissionId, bid.tenderId, "PENDING")).rejects.toThrow(/check/i);
  });
});
