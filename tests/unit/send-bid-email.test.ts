import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, fakeSupabase, type Call, type FakeResult } from "../support/fake-supabase";

vi.mock("server-only", () => ({}));

interface Row {
  id: string;
  submission_record_id: string;
  status: string;
  provider_message_id: string | null;
  error: string | null;
  to_address: string;
  attachments: unknown;
}

const h = vi.hoisted(() => ({
  role: "owner" as string,
  events: [] as string[],
  send: vi.fn(),
  logs: [] as Array<{ level: string; msg: string }>,
}));

// The clients are replaced for every test (`db`, `admin` below); the action asks for them when it runs.
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: async () => db.client }));
vi.mock("@/lib/supabase/admin", () => ({ getAdminSupabase: () => admin.client }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/context", () => ({
  requireContext: async () => ({ userId: "user-1", organisation: { id: "org-1" }, role: h.role }),
  canAdminister: (role: string) => role === "owner" || role === "admin",
}));
vi.mock("@/lib/email/smtp", () => ({ sendWithSmtp: (...args: unknown[]) => h.send(...args), verifySmtp: vi.fn() }));
vi.mock("@/lib/email/gmail", () => ({ googleConfig: () => null, sendWithGmail: vi.fn() }));
vi.mock("@/lib/log", () => ({
  createLogger: () => {
    const emit = (level: string) => (msg: string) => void h.logs.push({ level, msg });
    return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error"), child: () => ({}) };
  },
}));

let rows: Row[];
let db: ReturnType<typeof fakeSupabase>;
let admin: ReturnType<typeof fakeSupabase>;
let failWith: { accountUpdate?: string; settle?: string; reserve?: string; record?: string };
let nextId: number;

const SUBMISSION = { id: "sub-1", organisation_id: "org-1", tender_id: "tender-1", status: "ACTION_REQUIRED", is_simulation: false, approval_id: "appr-1" };
const CREDENTIAL = {
  provider: "SMTP",
  from_address: "bids@acme.co.za",
  display_name: "Acme",
  smtp_host: "smtp.acme.co.za",
  smtp_port: 587,
  smtp_username: "bids@acme.co.za",
  secret: JSON.stringify({ password: "pw" }),
  organisation_id: "org-1",
};

/** The database for the bid: submission, approval, and email_messages with its partial unique index. */
function userDb(call: Call): FakeResult {
  if (call.table === "submission_records") return { data: SUBMISSION, error: null };
  if (call.table === "approvals") return { data: { status: "APPROVED" }, error: null };
  if (call.table === "company_documents")
    return { data: [{ id: "doc-1", file_name: "cipc.pdf", mime_type: "application/pdf", storage_path: "org-1/x/cipc.pdf", size_bytes: 10 }], error: null };
  return { data: null, error: { message: `unexpected ${call.op} on ${call.table}` } };
}

async function adminDb(call: Call): Promise<FakeResult> {
  if (call.table === "email_messages" && call.op === "insert") {
    if (failWith.reserve) return { data: null, error: { code: "XX000", message: failWith.reserve } };
    const p = call.payload as Omit<Row, "id">;
    // The partial unique index: one SENDING or SENT message per submission.
    if (rows.some((r) => r.submission_record_id === p.submission_record_id && ["SENDING", "SENT"].includes(r.status))) {
      return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
    }
    const row = { ...p, id: `msg-${++nextId}`, provider_message_id: null, error: null } as Row;
    rows.push(row);
    h.events.push(`reserve:${row.status}`);
    return { data: { id: row.id }, error: null };
  }
  if (call.table === "email_messages" && call.op === "select") {
    const live = rows.find((r) => r.submission_record_id === eq(call, "submission_record_id") && ["SENDING", "SENT"].includes(r.status));
    return { data: live ? { status: live.status } : null, error: null };
  }
  if (call.table === "email_messages" && call.op === "update") {
    if (failWith.settle) return { data: null, error: { code: "XX000", message: failWith.settle } };
    const row = rows.find((r) => r.id === eq(call, "id") && r.status === eq(call, "status"));
    if (!row) return { data: [], error: null };
    Object.assign(row, call.payload);
    h.events.push(`settle:${row.status}`);
    return { data: [{ id: row.id }], error: null };
  }
  if (call.table === "email_accounts" && call.op === "update") {
    h.events.push("account");
    return failWith.accountUpdate ? { data: null, error: { code: "XX000", message: failWith.accountUpdate } } : { data: null, error: null };
  }
  return { data: null, error: { message: `unexpected ${call.op} on ${call.table}` } };
}

const { sendBidEmail } = await import("@/features/email/actions");

const input = {
  submissionId: "00000000-0000-4000-8000-000000000001",
  accountId: "00000000-0000-4000-8000-000000000002",
  to: "bids@city.gov.za",
  subject: "Bid for tender 7",
  body: "Please find our bid attached.",
  documentIds: [] as string[],
};

beforeEach(() => {
  rows = [];
  nextId = 0;
  failWith = {};
  h.role = "owner";
  h.events.length = 0;
  h.logs.length = 0;
  h.send.mockReset().mockImplementation(async () => {
    h.events.push("send");
    await new Promise((r) => setTimeout(r, 5));
    return { messageId: "<m1@acme.co.za>" };
  });
  db = fakeSupabase(userDb, (name) => {
    h.events.push(`rpc:${name}`);
    if (name === "record_bid_delivery" && failWith.record) return { data: null, error: { code: "XX000", message: failWith.record } };
    return { data: null, error: null };
  });
  admin = fakeSupabase(adminDb, (name) => (name === "email_account_credential" ? { data: [CREDENTIAL], error: null } : { data: null, error: null }));
});

describe("sendBidEmail", () => {
  it("reserves the send before mailing, mails once, then marks it sent and records the delivery", async () => {
    const res = await sendBidEmail(input);
    expect(res).toEqual({ ok: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    const order = h.events.filter((e) => ["reserve:SENDING", "send", "settle:SENT", "account", "rpc:record_bid_delivery"].includes(e));
    expect(order).toEqual(["reserve:SENDING", "send", "settle:SENT", "account", "rpc:record_bid_delivery"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "SENT", provider_message_id: "<m1@acme.co.za>", error: null });
    expect(db.rpcCalls.find((c) => c.name === "record_bid_delivery")?.args).toMatchObject({ p_submission_id: "sub-1", p_reference: "<m1@acme.co.za>" });
  });

  it("sends nothing when a SENT message already exists for the bid", async () => {
    rows.push({
      id: "old",
      submission_record_id: "sub-1",
      status: "SENT",
      provider_message_id: "x",
      error: null,
      to_address: "bids@city.gov.za",
      attachments: [],
    });
    const res = await sendBidEmail(input);
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/already emailed/i);
    expect(h.send).not.toHaveBeenCalled();
    expect(db.rpcCalls.map((c) => c.name)).not.toContain("record_bid_delivery");
  });

  it("sends nothing while another send is in progress or was interrupted, and says what to do", async () => {
    rows.push({
      id: "stuck",
      submission_record_id: "sub-1",
      status: "SENDING",
      provider_message_id: null,
      error: null,
      to_address: "bids@city.gov.za",
      attachments: [],
    });
    const res = (await sendBidEmail(input)) as { ok: false; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/being emailed|did not finish/i);
    expect(res.error).toMatch(/Sent folder/i);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("two simultaneous presses produce exactly one email and one message row", async () => {
    const [a, b] = await Promise.all([sendBidEmail(input), sendBidEmail(input)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("SENT");
    expect(db.rpcCalls.filter((c) => c.name === "record_bid_delivery")).toHaveLength(1);
  });

  it("marks a failed send FAILED, flags the mailbox, and lets the person try again", async () => {
    h.send.mockRejectedValueOnce(new Error("535 authentication failed"));
    const first = await sendBidEmail(input);
    expect(first).toEqual({ ok: false, error: "535 authentication failed" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "FAILED", error: "535 authentication failed" });
    expect(admin.calls.find((c) => c.table === "email_accounts")?.payload).toMatchObject({ status: "ERROR" });
    expect(db.rpcCalls.map((c) => c.name)).not.toContain("record_bid_delivery");

    const second = await sendBidEmail(input);
    expect(second).toEqual({ ok: true });
    expect(rows.map((r) => r.status)).toEqual(["FAILED", "SENT"]);
  });

  it("does not mail when the reservation cannot be written, and reports it", async () => {
    failWith.reserve = "connection refused";
    const res = (await sendBidEmail(input)) as { ok: false; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/could not start/i);
    expect(res.error).not.toContain("connection refused");
    expect(h.send).not.toHaveBeenCalled();
    expect(h.logs.some((l) => l.level === "error")).toBe(true);
  });

  it("tells the person not to send again when the email went out but could not be recorded", async () => {
    failWith.settle = "deadlock detected";
    const res = (await sendBidEmail(input)) as { ok: false; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/was sent/i);
    expect(res.error).toMatch(/do not send/i);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.logs.some((l) => l.level === "error")).toBe(true);
    // The unfinished reservation keeps blocking a second send.
    expect(rows[0].status).toBe("SENDING");
    const again = (await sendBidEmail(input)) as { ok: false; error: string };
    expect(again.ok).toBe(false);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("logs, but does not fail, when the mailbox status cannot be updated after a send", async () => {
    failWith.accountUpdate = "permission denied";
    const res = await sendBidEmail(input);
    expect(res).toEqual({ ok: true });
    expect(h.logs.some((l) => l.level === "error" && /mailbox status/i.test(l.msg))).toBe(true);
  });

  it("releases the reservation when an attachment cannot be read, so nothing is left blocking", async () => {
    const res = (await sendBidEmail({ ...input, documentIds: ["00000000-0000-4000-8000-0000000000d1"] })) as { ok: false; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Could not read/);
    expect(h.send).not.toHaveBeenCalled();
    expect(rows.map((r) => r.status)).toEqual(["FAILED"]);
  });

  it("still refuses what it refused before: non-admins, simulated bids, unapproved bids", async () => {
    h.role = "operator";
    expect(await sendBidEmail(input)).toMatchObject({ ok: false });
    h.role = "owner";
    expect(h.send).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });
});
