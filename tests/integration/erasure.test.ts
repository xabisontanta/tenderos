import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import type { Worker } from "@/workflows/worker";
import { DOCUMENT_BUCKET } from "@/lib/domain/documents";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";
import { eraseOrganisation } from "@/lib/privacy/erasure";
import { addMember, admin, bootstrapOrg, createTender, createUser, drainOrg, testPool, testWorker, type TestUser } from "./helpers";

let pool: Pool;
let worker: Worker;

const APPEND_ONLY = ["audit_logs", "agent_events", "tender_status_history", "agent_status_transitions", "cost_usage"] as const;
const PDF = "%PDF-1.4\n% TenderOS erasure test\n";

/** Every public table that carries organisation_id, except the audit trail (which is kept, de-identified). */
async function orgTables(): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `select c.table_name from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = 'organisation_id' order by 1`,
  );
  return rows.map((r) => r.table_name);
}

/** The text each table of an organisation holds, so a test can prove a person's details are gone from every one of them. */
async function orgTexts(orgId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of await orgTables()) {
    const { rows } = await pool.query<{ t: string }>(
      `select coalesce(string_agg(to_jsonb(x)::text, ' '), '') as t from public.${table} x where organisation_id = $1`,
      [orgId],
    );
    out[table] = rows[0].t;
  }
  return out;
}

async function orgText(orgId: string): Promise<string> {
  return Object.values(await orgTexts(orgId)).join(" ");
}

/** The tables whose text contains `needle`. */
async function tablesMentioning(orgId: string, needle: string): Promise<string[]> {
  return Object.entries(await orgTexts(orgId))
    .filter(([, text]) => text.includes(needle))
    .map(([table]) => table);
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params);
  return rows[0].n;
}

interface Scene {
  orgId: string;
  owner: TestUser;
  leaver: TestUser;
  keeper: TestUser;
  leaverName: string;
  accountId: string;
  secretId: string;
  tenderId: string;
  docPath: string;
}

/**
 * An organisation in which one member has done a bit of everything: connected a mailbox and a browser
 * pairing, created and run a tender, decided its approval with a free-text comment, uploaded a document,
 * emailed a bid, accepted the terms and changed settings.
 */
async function sceneWithActedMember(label: string): Promise<Scene> {
  const owner = await createUser(`${label}-owner`);
  const leaver = await createUser(`${label}-leaver`);
  const keeper = await createUser(`${label}-keeper`);
  const orgId = await bootstrapOrg(owner);
  await addMember(orgId, leaver.id, "admin", pool);
  await addMember(orgId, keeper.id, "admin", pool);
  const leaverName = `Thandi Leaver ${randomUUID().slice(0, 6)}`;
  await pool.query(`update public.profiles set full_name = $2 where id = $1`, [leaver.id, leaverName]);

  const mailbox = await leaver.client.rpc("connect_email_account", {
    p_org: orgId,
    p_provider: "SMTP",
    p_from: leaver.email,
    p_display_name: leaverName,
    p_secret: JSON.stringify({ password: "mailbox-password-123" }),
    p_smtp_host: "smtp.acme.co.za",
    p_smtp_port: 587,
    p_smtp_username: leaver.email,
  });
  expect(mailbox.error).toBeNull();
  const accountId = mailbox.data as unknown as string;
  const { rows: acc } = await pool.query<{ secret_id: string }>(`select secret_id from public.email_accounts where id = $1`, [accountId]);

  expect((await leaver.client.rpc("create_autofill_token", { p_org: orgId, p_label: `${leaverName}'s laptop` })).error).toBeNull();
  expect((await leaver.client.rpc("accept_legal", { p_terms_version: LEGAL_VERSIONS.terms, p_privacy_version: LEGAL_VERSIONS.privacy })).error).toBeNull();
  expect(
    (await leaver.client.rpc("set_kill_switch", { p_org: orgId, p_engaged: true, p_reason: `Paused by ${leaverName} (${leaver.email})` })).error,
  ).toBeNull();
  expect((await leaver.client.rpc("set_kill_switch", { p_org: orgId, p_engaged: false, p_reason: "Resuming after the check" })).error).toBeNull();

  const docPath = `${orgId}/${randomUUID()}/cipc.pdf`;
  const up = await leaver.client.storage
    .from(DOCUMENT_BUCKET)
    .upload(docPath, new Blob([PDF], { type: "application/pdf" }), { contentType: "application/pdf" });
  expect(up.error).toBeNull();
  expect(
    (await leaver.client.rpc("register_company_document", { p_org: orgId, p_doc_type: "cipc_registration", p_title: "CIPC", p_path: docPath })).error,
  ).toBeNull();

  await pool.query(
    `insert into public.company_profiles (organisation_id, legal_name, contact_person, contact_email, contact_phone, authorised_signatory)
     values ($1, 'Acme Trading (Pty) Ltd', $2, $3, '+27 82 555 0100', $2)`,
    [orgId, leaverName, leaver.email],
  );

  const tender = await createTender(leaver.client, orgId, { reference_number: `ERA-${randomUUID().slice(0, 8)}` });
  const started = await leaver.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
  expect(started.error).toBeNull();
  await drainOrg(worker, pool, orgId);
  const { data: approval } = await leaver.client.from("approvals").select("id").eq("workflow_run_id", started.data!).single();
  const decided = await leaver.client.rpc("decide_approval", {
    p_approval_id: approval!.id,
    p_approve: true,
    p_comments: `Approved by ${leaverName}, questions to ${leaver.email}`,
  });
  expect(decided.error).toBeNull();
  await drainOrg(worker, pool, orgId);

  const { rows: sub } = await pool.query<{ id: string }>(`select id from public.submission_records where tender_id = $1`, [tender.id]);
  await pool.query(
    `update public.submission_records set receipt = receipt || jsonb_build_object('delivered_by', $2::text, 'delivery_note', $3::text) where id = $1`,
    [sub[0].id, leaver.id, `Emailed to bids@city.gov.za from ${leaver.email} with 2 attachment(s)`],
  );
  await pool.query(
    `insert into public.email_messages (organisation_id, email_account_id, tender_id, submission_record_id, sent_by, from_address, to_address, subject, status, error)
     values ($1, $2, $3, $4, $5, $6, 'bids@city.gov.za', 'Bid for ERA tender', 'FAILED', $7)`,
    [orgId, accountId, tender.id, sub[0].id, leaver.id, leaver.email, `Rejected for ${leaver.email}`],
  );

  return { orgId, owner, leaver, keeper, leaverName, accountId, secretId: acc[0].secret_id, tenderId: tender.id, docPath };
}

beforeAll(async () => {
  pool = testPool();
  worker = testWorker(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("append-only tables", () => {
  it("still reject ordinary updates, deletes and TRUNCATE for the database owner", async () => {
    const owner = await createUser("ao-owner");
    const orgId = await bootstrapOrg(owner);
    const t = await createTender(owner.client, orgId, { reference_number: `AO-${randomUUID().slice(0, 8)}` });
    await owner.client.rpc("start_tender_workflow", { p_tender_id: t.id });
    await drainOrg(worker, pool, orgId);
    await pool.query(`insert into public.cost_usage (organisation_id, provider, model) values ($1, 'rules', 'none')`, [orgId]);

    for (const table of APPEND_ONLY) {
      expect(await count(`select 1 from public.${table} where organisation_id = $1`, [orgId]), `${table} has rows to protect`).toBeGreaterThan(0);
      await expect(pool.query(`delete from public.${table} where organisation_id = $1`, [orgId]), `${table} delete`).rejects.toThrow(/append-only/);
      await expect(pool.query(`truncate public.${table}`), `${table} truncate`).rejects.toThrow(/append-only/);
    }
    await expect(pool.query(`update public.audit_logs set action = 'tampered' where organisation_id = $1`, [orgId])).rejects.toThrow(/append-only/);
    await expect(pool.query(`update public.agent_events set summary = 'tampered' where organisation_id = $1`, [orgId])).rejects.toThrow(/append-only/);
    await expect(pool.query(`update public.cost_usage set cost_usd = 1 where organisation_id = $1`, [orgId])).rejects.toThrow(/append-only/);
    // Clearing the actor is the one allowed update; changing anything else in the same statement is not.
    await expect(pool.query(`update public.audit_logs set actor_user_id = null, action = 'tampered' where organisation_id = $1`, [orgId])).rejects.toThrow(
      /append-only/,
    );
  });

  it("are not truncatable by the API roles", async () => {
    for (const table of APPEND_ONLY) {
      for (const role of ["service_role", "authenticated", "anon"]) {
        const { rows } = await pool.query(`select has_table_privilege($1, $2, 'TRUNCATE') as can`, [role, `public.${table}`]);
        expect(rows[0].can, `${role} on ${table}`).toBe(false);
      }
    }
  });

  it("cannot be unlocked by a browser session", async () => {
    const user = await createUser("ao-user");
    const orgId = await bootstrapOrg(user);
    // The API does not expose set_config, and the roles behind it hold no UPDATE or DELETE on these tables.
    const attempt = await user.client.from("audit_logs").delete().eq("organisation_id", orgId);
    expect(attempt.error).not.toBeNull();
    expect(await count(`select 1 from public.audit_logs where organisation_id = $1`, [orgId])).toBeGreaterThan(0);
  });
});

describe("deleting a user who has acted", () => {
  it("is not blocked by any foreign key to a user or an organisation, now or in a later migration", async () => {
    const { rows } = await pool.query(
      `select conrelid::regclass::text as tbl, conname from pg_constraint
        where contype = 'f' and connamespace = 'public'::regnamespace
          and confrelid in ('auth.users'::regclass, 'public.organisations'::regclass)
          and confdeltype in ('r', 'a')`,
    );
    expect(rows, "make it on delete set null or cascade, or erasure fails for everyone who ever used the feature").toEqual([]);
  });

  it("no longer fails (audit trail, events and sent email keep their rows)", async () => {
    const s = await sceneWithActedMember("del");
    const auditBefore = await count(`select 1 from public.audit_logs where organisation_id = $1`, [s.orgId]);
    const byLeaver = await count(`select 1 from public.audit_logs where actor_user_id = $1`, [s.leaver.id]);
    expect(byLeaver).toBeGreaterThan(0);

    expect((await admin().auth.admin.deleteUser(s.leaver.id)).error).toBeNull();

    expect(await count(`select 1 from public.audit_logs where organisation_id = $1`, [s.orgId])).toBe(auditBefore);
    expect(await count(`select 1 from public.audit_logs where actor_user_id = $1`, [s.leaver.id])).toBe(0);
    expect(await count(`select 1 from public.email_messages where organisation_id = $1 and sent_by is null`, [s.orgId])).toBe(1);
    // The mailbox went with the member, and so did its credential in Vault.
    expect(await count(`select 1 from public.email_accounts where id = $1`, [s.accountId])).toBe(0);
    expect(await count(`select 1 from vault.secrets where id = $1`, [s.secretId])).toBe(0);
  });

  it("does not leave a mailbox credential in Vault when a member is removed", async () => {
    const s = await sceneWithActedMember("rm");
    await pool.query(`delete from public.organisation_members where organisation_id = $1 and user_id = $2`, [s.orgId, s.leaver.id]);
    expect(await count(`select 1 from public.email_accounts where id = $1`, [s.accountId])).toBe(0);
    expect(await count(`select 1 from vault.secrets where id = $1`, [s.secretId])).toBe(0);
    expect(await count(`select 1 from public.email_messages where email_account_id is null and organisation_id = $1`, [s.orgId])).toBe(1);
  });
});

describe("erase_user", () => {
  it("is for the service role only", async () => {
    const s = await sceneWithActedMember("perm");
    expect((await s.owner.client.rpc("erase_user", { p_user_id: s.leaver.id } as never)).error).not.toBeNull();
    expect((await s.leaver.client.rpc("erase_user", { p_user_id: s.leaver.id } as never)).error).not.toBeNull();
    expect((await s.owner.client.rpc("export_user_data", { p_user_id: s.leaver.id } as never)).error).not.toBeNull();
    expect((await s.owner.client.rpc("erase_organisation", { p_org: s.orgId } as never)).error).not.toBeNull();
    expect((await s.owner.client.rpc("export_organisation_data", { p_org: s.orgId } as never)).error).not.toBeNull();
    expect(await count(`select 1 from auth.users where id = $1`, [s.leaver.id])).toBe(1);
  });

  it("removes the person everywhere and de-identifies what must stay", async () => {
    const s = await sceneWithActedMember("era");
    const keeperClient = s.keeper.client;
    const orgRowsBefore = await count(`select 1 from public.tenders where organisation_id = $1`, [s.orgId]);
    expect(await orgText(s.orgId)).toContain(s.leaver.email);

    const res = await admin().rpc("erase_user", { p_user_id: s.leaver.id, p_reference: "REQ-2026-001" } as never);
    expect(res.error).toBeNull();
    const summary = res.data as unknown as { erased: string; pseudonym: string };
    expect(summary.erased).toBe("user");
    expect(summary.pseudonym).toMatch(/^erased-[0-9a-f]{8}$/);

    // The account and everything tied to it is gone.
    expect(await count(`select 1 from auth.users where id = $1`, [s.leaver.id])).toBe(0);
    expect(await count(`select 1 from public.profiles where id = $1`, [s.leaver.id])).toBe(0);
    expect(await count(`select 1 from public.organisation_members where user_id = $1`, [s.leaver.id])).toBe(0);
    expect(await count(`select 1 from public.email_accounts where user_id = $1`, [s.leaver.id])).toBe(0);
    expect(await count(`select 1 from vault.secrets where id = $1`, [s.secretId])).toBe(0);
    expect(await count(`select 1 from public.autofill_tokens where user_id = $1`, [s.leaver.id])).toBe(0);
    expect(await count(`select 1 from public.notifications where user_id = $1`, [s.leaver.id])).toBe(0);
    expect(await count(`select 1 from public.legal_acceptances where user_id = $1`, [s.leaver.id])).toBe(0);
    expect(await count(`select 1 from auth.audit_log_entries where payload::text like $1`, [`%${s.leaver.id}%`])).toBe(0);

    // Nothing in the organisation's data names them any more: not their id, address, name or free text.
    expect(await tablesMentioning(s.orgId, s.leaver.id), "tables still holding the user id").toEqual([]);
    expect(await tablesMentioning(s.orgId, s.leaver.email), "tables still holding the email address").toEqual([]);
    expect(await tablesMentioning(s.orgId, s.leaverName), "tables still holding the name").toEqual([]);

    // The records themselves stay.
    expect(await count(`select 1 from public.audit_logs where organisation_id = $1 and action = 'approval.granted'`, [s.orgId])).toBe(1);
    expect(await count(`select 1 from public.tender_status_history where tender_id = $1`, [s.tenderId])).toBeGreaterThan(1);
    expect(await count(`select 1 from public.email_messages where organisation_id = $1 and sent_by is null and to_address = '[erased]'`, [s.orgId])).toBe(1);
    expect(
      await count(`select 1 from public.company_profiles where organisation_id = $1 and contact_email is null and contact_person is null`, [s.orgId]),
    ).toBe(1);
    expect(await count(`select 1 from public.company_documents where organisation_id = $1 and uploaded_by is null`, [s.orgId])).toBe(1);

    // One record that an erasure happened, with no personal data in it.
    const { rows } = await pool.query(`select * from public.audit_logs where organisation_id = $1 and action = 'popia.user_erased'`, [s.orgId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_type).toBe("system");
    const record = JSON.stringify(rows[0]);
    for (const secret of [s.leaver.id, s.leaver.email, s.leaverName]) expect(record).not.toContain(secret);
    expect(rows[0].resource_id).toBe(summary.pseudonym);
    expect(rows[0].metadata).toMatchObject({ reference: "REQ-2026-001" });

    // The rest of the organisation still works.
    expect(await count(`select 1 from public.tenders where organisation_id = $1`, [s.orgId])).toBe(orgRowsBefore);
    const again = await createTender(keeperClient, s.orgId, { reference_number: `AFTER-${randomUUID().slice(0, 8)}` });
    expect((await keeperClient.rpc("start_tender_workflow", { p_tender_id: again.id })).error).toBeNull();
    await drainOrg(worker, pool, s.orgId);
    const { data: runs } = await s.owner.client.from("workflow_runs").select("status").eq("tender_id", again.id);
    expect(runs).toEqual([{ status: "WAITING_APPROVAL" }]);
  });

  it("refuses the last owner of an organisation that still has members, and unknown users", async () => {
    const s = await sceneWithActedMember("own");
    const res = await admin().rpc("erase_user", { p_user_id: s.owner.id } as never);
    expect(res.error?.message).toMatch(/only owner/i);
    expect(await count(`select 1 from auth.users where id = $1`, [s.owner.id])).toBe(1);
    const missing = await admin().rpc("erase_user", { p_user_id: randomUUID() } as never);
    expect(missing.error?.message).toMatch(/not found/i);
    const bad = await admin().rpc("erase_user", { p_user_id: s.keeper.id, p_reference: "has spaces and an email@x.test" } as never);
    expect(bad.error).not.toBeNull();
    expect(await count(`select 1 from auth.users where id = $1`, [s.keeper.id])).toBe(1);
  });
});

describe("erase_organisation", () => {
  it("removes the organisation, its members' accounts, its files and its secrets, and keeps a de-identified trail", async () => {
    const s = await sceneWithActedMember("org");
    const other = await sceneWithActedMember("bystander");
    const otherText = await orgText(other.orgId);
    const otherAudit = await count(`select 1 from public.audit_logs where organisation_id = $1`, [other.orgId]);

    const orgName = (await pool.query<{ name: string }>(`select name from public.organisations where id = $1`, [s.orgId])).rows[0].name;
    expect(await count(`select 1 from storage.objects where bucket_id = $1 and name = $2`, [DOCUMENT_BUCKET, s.docPath])).toBe(1);
    // An upload that was never registered is removed too.
    const orphan = `${s.orgId}/${randomUUID()}/orphan.pdf`;
    expect(
      (await s.owner.client.storage.from(DOCUMENT_BUCKET).upload(orphan, new Blob([PDF], { type: "application/pdf" }), { contentType: "application/pdf" }))
        .error,
    ).toBeNull();

    const result = await eraseOrganisation(admin(), s.orgId, { reference: "REQ-2026-002" });
    expect(result.erased).toBe("organisation");
    expect(result.members_erased).toBe(3);
    expect(result.files_removed).toBe(2);

    expect(await count(`select 1 from public.organisations where id = $1`, [s.orgId])).toBe(0);
    for (const table of (await orgTables()).filter((t) => t !== "audit_logs")) {
      expect(await count(`select 1 from public.${table} where organisation_id = $1`, [s.orgId]), table).toBe(0);
    }
    for (const u of [s.owner, s.leaver, s.keeper]) expect(await count(`select 1 from auth.users where id = $1`, [u.id])).toBe(0);
    expect(await count(`select 1 from vault.secrets where id = $1`, [s.secretId])).toBe(0);
    expect(await count(`select 1 from storage.objects where bucket_id = $1 and name like $2`, [DOCUMENT_BUCKET, `${s.orgId}/%`])).toBe(0);

    // The audit trail outlives the organisation but names nobody.
    const { rows } = await pool.query(`select action, metadata, actor_user_id from public.audit_logs where organisation_id = $1`, [s.orgId]);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every((r) => r.actor_user_id === null)).toBe(true);
    const trail = JSON.stringify(rows);
    for (const secret of [s.leaver.id, s.owner.id, s.leaver.email, s.owner.email, s.leaverName, orgName]) expect(trail).not.toContain(secret);
    const erased = rows.filter((r) => r.action === "popia.organisation_erased");
    expect(erased).toHaveLength(1);
    expect(erased[0].metadata).toMatchObject({ reference: "REQ-2026-002", members_erased: 3 });

    // Another organisation is untouched.
    expect(await orgText(other.orgId)).toBe(otherText);
    expect(await count(`select 1 from public.audit_logs where organisation_id = $1`, [other.orgId])).toBe(otherAudit);
    expect(await count(`select 1 from vault.secrets where id = $1`, [other.secretId])).toBe(1);
    expect(await count(`select 1 from auth.users where id = $1`, [other.leaver.id])).toBe(1);
  });

  it("refuses an organisation that does not exist", async () => {
    const res = await admin().rpc("erase_organisation", { p_org: randomUUID() } as never);
    expect(res.error?.message).toMatch(/not found/i);
  });
});

describe("data export", () => {
  it("gives a person their own data and no secrets", async () => {
    const s = await sceneWithActedMember("exu");
    const res = await admin().rpc("export_user_data", { p_user_id: s.leaver.id, p_actor: s.owner.id } as never);
    expect(res.error).toBeNull();
    const data = res.data as unknown as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      [
        "approvals_decided",
        "audit_entries",
        "browser_helper_pairings",
        "consents",
        "documents_uploaded",
        "emails_sent",
        "generated_at",
        "limits",
        "mailboxes",
        "membership",
        "notifications",
        "profile",
        "subject",
        "tenders_created",
      ].sort(),
    );
    expect(data.subject).toMatchObject({ id: s.leaver.id, email: s.leaver.email });
    expect(data.profile).toMatchObject({ full_name: s.leaverName });
    expect(data.membership).toMatchObject([{ organisation_id: s.orgId, role: "admin" }]);
    expect((data.consents as unknown[]).length).toBe(2);
    expect((data.mailboxes as Array<{ from_address: string }>)[0].from_address).toBe(s.leaver.email);
    expect((data.browser_helper_pairings as unknown[]).length).toBe(1);
    expect((data.tenders_created as unknown[]).length).toBe(1);
    expect((data.audit_entries as unknown[]).length).toBeGreaterThan(3);
    expect((data.emails_sent as unknown[]).length).toBe(1);
    expect((data.documents_uploaded as unknown[]).length).toBe(1);
    expect((data.approvals_decided as unknown[]).length).toBe(1);

    const json = JSON.stringify(data);
    expect(json).not.toContain("secret_id");
    expect(json).not.toContain("token_hash");
    expect(json).not.toContain("mailbox-password-123");
    expect(json).not.toContain("ip_hmac");
    expect(json).not.toContain(s.secretId);
    expect(json).not.toContain(s.docPath);

    const { rows } = await pool.query(`select actor_user_id, metadata from public.audit_logs where action = 'popia.user_exported' and organisation_id = $1`, [
      s.orgId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe(s.owner.id);
  });

  it("gives an organisation its data, without secrets or file contents", async () => {
    const s = await sceneWithActedMember("exo");
    const res = await admin().rpc("export_organisation_data", { p_org: s.orgId, p_actor: s.owner.id } as never);
    expect(res.error).toBeNull();
    const data = res.data as unknown as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      [
        "approvals",
        "audit_log",
        "company_profile",
        "discovery_runs",
        "documents",
        "email_accounts",
        "email_messages",
        "events",
        "generated_at",
        "limits",
        "members",
        "organisation",
        "settings",
        "status_history",
        "submission_records",
        "tasks",
        "tenders",
        "workflow_runs",
      ].sort(),
    );
    expect(data.organisation).toMatchObject({ id: s.orgId });
    expect((data.members as unknown[]).length).toBe(3);
    expect((data.tenders as unknown[]).length).toBe(1);
    expect((data.documents as Array<{ title: string }>)[0].title).toBe("CIPC");
    expect((data.email_accounts as unknown[]).length).toBe(1);
    expect((data.email_messages as unknown[]).length).toBe(1);
    expect((data.audit_log as unknown[]).length).toBeGreaterThan(5);
    expect((data.company_profile as { legal_name: string }).legal_name).toBe("Acme Trading (Pty) Ltd");

    const json = JSON.stringify(data);
    expect(json).not.toContain("secret_id");
    expect(json).not.toContain("token_hash");
    expect(json).not.toContain("mailbox-password-123");
    expect(json).not.toContain(s.secretId);
    expect(json).not.toContain(s.docPath);
    expect(json).not.toContain("storage_path");
    expect(json).not.toContain("TenderOS erasure test");

    const { rows } = await pool.query(`select actor_user_id from public.audit_logs where action = 'popia.organisation_exported' and organisation_id = $1`, [
      s.orgId,
    ]);
    expect(rows).toEqual([{ actor_user_id: s.owner.id }]);
  });

  it("limits repeated exports of the same person and organisation", async () => {
    const s = await sceneWithActedMember("rate");
    for (let i = 0; i < 10; i++) {
      expect((await admin().rpc("export_user_data", { p_user_id: s.keeper.id } as never)).error).toBeNull();
      expect((await admin().rpc("export_organisation_data", { p_org: s.orgId } as never)).error).toBeNull();
    }
    expect((await admin().rpc("export_user_data", { p_user_id: s.keeper.id } as never)).error?.message).toMatch(/Too many requests/);
    expect((await admin().rpc("export_organisation_data", { p_org: s.orgId } as never)).error?.message).toMatch(/Too many requests/);
  });
});

describe("retention", () => {
  it("is scheduled", async () => {
    const { rows } = await pool.query(`select schedule, command from cron.job where jobname = 'tenderos-retention-purge'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toContain("private.run_retention_purge()");
  });

  it("purges completed jobs, old events and notifications, and audit rows past the organisation's retention", async () => {
    const owner = await createUser("ret-owner");
    const orgId = await bootstrapOrg(owner);
    const age = (days: number) => `now() - interval '${days} days'`;

    await pool.query(`update public.system_settings set audit_retention_days = 365 where organisation_id = $1`, [orgId]);
    const job = (days: number, status: string) =>
      pool.query(`insert into public.jobs (organisation_id, kind, status, completed_at) values ($1, 'test.job', $2::public.job_status, ${age(days)})`, [
        orgId,
        status,
      ]);
    await job(40, "COMPLETED");
    await job(10, "COMPLETED");
    await job(40, "DEAD");

    const event = (days: number) =>
      pool.query(`insert into public.agent_events (organisation_id, event_type, summary, created_at) values ($1, 'TEST_EVENT', 'old', ${age(days)})`, [orgId]);
    await event(400);
    await event(100);
    const note = (days: number) =>
      pool.query(`insert into public.notifications (organisation_id, user_id, kind, title, created_at) values ($1, $2, 'TEST_NOTE', 'old', ${age(days)})`, [
        orgId,
        owner.id,
      ]);
    await note(200);
    await note(20);
    const audit = (days: number) =>
      pool.query(
        `insert into public.audit_logs (organisation_id, actor_type, action, resource_type, created_at) values ($1, 'system', 'test.audit', 'test', ${age(days)})`,
        [orgId],
      );
    await audit(400);
    await audit(300);
    const cost = (days: number) =>
      pool.query(`insert into public.cost_usage (organisation_id, provider, model, created_at) values ($1, 'rules', 'old', ${age(days)})`, [orgId]);
    await cost(400);
    await cost(300);
    // An organisation that no longer exists keeps its trail for the default period (seven years).
    const gone = randomUUID();
    await pool.query(
      `insert into public.audit_logs (organisation_id, actor_type, action, resource_type, created_at) values ($1, 'system', 'test.audit', 'test', ${age(400)}), ($1, 'system', 'test.audit', 'test', ${age(2600)})`,
      [gone],
    );

    const { rows } = await pool.query(`select private.run_retention_purge() as r`);
    expect(rows[0].r).toMatchObject({
      jobs: expect.any(Number),
      agent_events: expect.any(Number),
      notifications: expect.any(Number),
      audit_logs: expect.any(Number),
    });

    expect(await count(`select 1 from public.jobs where organisation_id = $1 and status = 'COMPLETED'`, [orgId])).toBe(1);
    expect(await count(`select 1 from public.jobs where organisation_id = $1 and status = 'DEAD'`, [orgId])).toBe(1);
    expect(await count(`select 1 from public.agent_events where organisation_id = $1 and event_type = 'TEST_EVENT'`, [orgId])).toBe(1);
    expect(await count(`select 1 from public.notifications where organisation_id = $1`, [orgId])).toBe(1);
    expect(await count(`select 1 from public.audit_logs where organisation_id = $1 and action = 'test.audit'`, [orgId])).toBe(1);
    expect(await count(`select 1 from public.cost_usage where organisation_id = $1 and model = 'old'`, [orgId])).toBe(1);
    expect(await count(`select 1 from public.audit_logs where organisation_id = $1 and action = 'test.audit'`, [gone])).toBe(1);
  });

  it("never keeps audit rows for less than 365 days, whatever the setting", async () => {
    const owner = await createUser("ret-min");
    const orgId = await bootstrapOrg(owner);
    // The column check refuses less than 365; the purge also floors it, in case the check is ever loosened.
    await expect(pool.query(`update public.system_settings set audit_retention_days = 30 where organisation_id = $1`, [orgId])).rejects.toThrow(/check/i);
    await pool.query(
      `insert into public.audit_logs (organisation_id, actor_type, action, resource_type, created_at) values ($1, 'system', 'test.recent', 'test', now() - interval '200 days')`,
      [orgId],
    );
    await pool.query(`select private.run_retention_purge()`);
    expect(await count(`select 1 from public.audit_logs where organisation_id = $1 and action = 'test.recent'`, [orgId])).toBe(1);
  });

  it("honours a longer retention setting", async () => {
    const owner = await createUser("ret-long");
    const orgId = await bootstrapOrg(owner);
    await pool.query(`update public.system_settings set audit_retention_days = 3650 where organisation_id = $1`, [orgId]);
    await pool.query(
      `insert into public.audit_logs (organisation_id, actor_type, action, resource_type, created_at) values ($1, 'system', 'test.long', 'test', now() - interval '3000 days')`,
      [orgId],
    );
    await pool.query(`select private.run_retention_purge()`);
    expect(await count(`select 1 from public.audit_logs where organisation_id = $1 and action = 'test.long'`, [orgId])).toBe(1);
  });

  it("removes mailbox credentials that no mailbox points at", async () => {
    const orphan = await pool.query<{ id: string }>(`select vault.create_secret('orphaned', 'tenderos_email_' || gen_random_uuid()::text, 'orphan') as id`);
    const { rows } = await pool.query(`select private.run_retention_purge() as r`);
    expect(rows[0].r.mailbox_secrets).toBeGreaterThanOrEqual(1);
    expect(await count(`select 1 from vault.secrets where id = $1`, [orphan.rows[0].id])).toBe(0);
  });
});
