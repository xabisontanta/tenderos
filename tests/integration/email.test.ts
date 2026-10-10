import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import type { Worker } from "@/workflows/worker";
import { DOCUMENT_BUCKET } from "@/lib/domain/documents";
import { addMember, admin, bootstrapOrg, createTender, createUser, drainOrg, testPool, testWorker, type TestUser } from "./helpers";

let pool: Pool;
let worker: Worker;
let owner: TestUser;
let admin2: TestUser;
let operator: TestUser;
let outsider: TestUser;
let orgId: string;

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

function connect(user: TestUser, from: string, secret = JSON.stringify({ password: "app-password-123" })) {
  return user.client.rpc("connect_email_account", {
    p_org: orgId,
    p_provider: "SMTP",
    p_from: from,
    p_display_name: "Acme Tenders",
    p_secret: secret,
    p_smtp_host: "smtp.acme.co.za",
    p_smtp_port: 587,
    p_smtp_username: from,
  });
}

beforeAll(async () => {
  pool = testPool();
  worker = testWorker(pool);
  owner = await createUser("mail-owner");
  admin2 = await createUser("mail-admin");
  operator = await createUser("mail-operator");
  outsider = await createUser("mail-outsider");
  orgId = await bootstrapOrg(owner);
  await addMember(orgId, admin2.id, "admin", pool);
  await addMember(orgId, operator.id, "operator", pool);
  await bootstrapOrg(outsider);
});

afterAll(async () => {
  await pool.end();
});

describe("sending mailboxes", () => {
  it("stores the credential in Vault where browsers cannot read it", async () => {
    expect((await connect(operator, "ops@acme.co.za")).error).not.toBeNull();
    expect((await connect(outsider, "x@evil.test")).error).not.toBeNull();
    const { data: id, error } = await connect(owner, "Tenders@Acme.co.za");
    expect(error).toBeNull();

    const { data: rows } = await owner.client.from("email_accounts").select("id, from_address, provider").eq("id", id!);
    expect(rows).toEqual([{ id, from_address: "tenders@acme.co.za", provider: "SMTP" }]);
    const secretCol = await owner.client.from("email_accounts").select("secret_id").eq("id", id!);
    expect(secretCol.error).not.toBeNull();
    expect((await outsider.client.from("email_accounts").select("id").eq("organisation_id", orgId)).data).toEqual([]);
    expect((await owner.client.from("email_accounts").insert({} as never)).error).not.toBeNull();

    // Signed-in members cannot decrypt, even their own mailbox.
    expect((await owner.client.rpc("email_account_credential", { p_id: id!, p_user: owner.id })).error).not.toBeNull();
    // The server can, but only for the member who connected it.
    const mine = await admin().rpc("email_account_credential", { p_id: id!, p_user: owner.id });
    expect(mine.data?.[0]?.secret).toBe(JSON.stringify({ password: "app-password-123" }));
    const theirs = await admin().rpc("email_account_credential", { p_id: id!, p_user: admin2.id });
    expect(theirs.data).toEqual([]);
  });

  it("replaces credentials on reconnect and deletes them from Vault on disconnect", async () => {
    const { data: first } = await owner.client.from("email_accounts").select("id").is("revoked_at", null).single();
    const { data: second, error } = await connect(owner, "tenders@acme.co.za", JSON.stringify({ password: "rotated-password" }));
    expect(error).toBeNull();
    const { rows: old } = await pool.query(`select revoked_at is not null as revoked, secret_id from public.email_accounts where id = $1`, [first!.id]);
    expect(old[0].revoked).toBe(true);
    const { rows: oldSecret } = await pool.query(`select count(*)::int as n from vault.secrets where id = $1`, [old[0].secret_id]);
    expect(oldSecret[0].n).toBe(0);

    expect((await operator.client.rpc("disconnect_email_account", { p_id: second! })).error).not.toBeNull();
    expect((await admin2.client.rpc("disconnect_email_account", { p_id: second! })).error).toBeNull();
    expect((await admin().rpc("email_account_credential", { p_id: second!, p_user: owner.id })).data).toEqual([]);
    const { rows: audit } = await pool.query(`select action from public.audit_logs where organisation_id = $1 and action like 'email.%' order by action`, [
      orgId,
    ]);
    expect(audit.map((a) => a.action)).toEqual(["email.connected", "email.connected", "email.disconnected", "email.disconnected"]);
  });

  it("records a person's delivery of an approved email bid and closes the run", async () => {
    for (const [type, title, expires] of [
      ["cipc_registration", "CIPC CoR 14.3", undefined],
      ["csd_registration", "CSD summary", undefined],
      ["tax_compliance", "TCS PIN letter", inDays(200)],
      ["sbd_declarations", "SBD 4 and 6.1", undefined],
    ] as const) {
      const path = `${orgId}/${type}/doc.pdf`;
      const up = await owner.client.storage.from(DOCUMENT_BUCKET).upload(path, new Blob(["%PDF-1.4\n"], { type: "application/pdf" }), {
        contentType: "application/pdf",
      });
      expect(up.error).toBeNull();
      const reg = await owner.client.rpc("register_company_document", { p_org: orgId, p_doc_type: type, p_title: title, p_path: path, p_expires_at: expires });
      expect(reg.error).toBeNull();
    }
    await owner.client.from("company_profiles").insert({ organisation_id: orgId, legal_name: "Acme Trading (Pty) Ltd", bbbee_level: 2 });

    const tender = await createTender(owner.client, orgId, {
      is_simulation: false,
      reference_number: `MAIL-${Date.now()}`,
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

    expect((await operator.client.rpc("record_bid_delivery", { p_submission_id: sub!.id, p_reference: "x" })).error).not.toBeNull();
    expect((await outsider.client.rpc("record_bid_delivery", { p_submission_id: sub!.id })).error).not.toBeNull();
    const done = await owner.client.rpc("record_bid_delivery", { p_submission_id: sub!.id, p_reference: "<msg-1@acme.co.za>", p_note: "Emailed" });
    expect(done.error).toBeNull();
    expect((await owner.client.rpc("record_bid_delivery", { p_submission_id: sub!.id })).error?.message).toMatch(/already recorded/);

    const { data: after } = await owner.client.from("submission_records").select("status, external_reference, submitted_at").eq("id", sub!.id).single();
    expect(after).toMatchObject({ status: "SUBMITTED", external_reference: "<msg-1@acme.co.za>" });
    expect(after!.submitted_at).not.toBeNull();
    const { data: t } = await owner.client.from("tenders").select("status").eq("id", tender.id).single();
    expect(t!.status).toBe("SUBMITTED");
    const { data: run } = await owner.client.from("workflow_runs").select("status, outcome").eq("id", started.data!).single();
    expect(run).toEqual({ status: "COMPLETED", outcome: "SUBMITTED" });
  });

  it("refuses to record a simulated bid as delivered", async () => {
    const tender = await createTender(owner.client, orgId, { reference_number: `SIM-${Date.now()}` });
    const started = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    await drainOrg(worker, pool, orgId);
    const { data: approval } = await owner.client.from("approvals").select("id").eq("workflow_run_id", started.data!).single();
    await owner.client.rpc("decide_approval", { p_approval_id: approval!.id, p_approve: true, p_comments: "ok" });
    await drainOrg(worker, pool, orgId);
    const { data: sub } = await owner.client.from("submission_records").select("id").eq("workflow_run_id", started.data!).single();
    const res = await owner.client.rpc("record_bid_delivery", { p_submission_id: sub!.id });
    expect(res.error?.message).toMatch(/Simulated/);
  });
});
