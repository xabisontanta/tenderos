import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import type { Worker } from "@/workflows/worker";
import { DOCUMENT_BUCKET } from "@/lib/domain/documents";
import { addMember, bootstrapOrg, createTender, createUser, drainOrg, testPool, testWorker, type TestUser } from "./helpers";

/**
 * "Require MFA for everyone" (migration 063). A real second factor needs a TOTP-enabled Auth server (tests/integration/mfa.test.ts),
 * so these tests set the session's claims the way PostgREST does (`request.jwt.claims`, with `aal`) and call the functions
 * as the `authenticated` role. That exercises exactly what the database sees; the Auth server's part (issuing an aal2 token) is
 * in docs/auth.md.
 */
let pool: Pool;
let worker: Worker;

type Level = "aal1" | "aal2";
interface Outcome {
  rows: Array<Record<string, unknown>>;
  error: { code?: string; message: string } | null;
}

/** One statement, as `authenticated`, with a session at the given level. Commits unless it fails. */
async function as(user: Pick<TestUser, "id" | "email">, aal: Level | null, text: string, params: unknown[] = []): Promise<Outcome> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    if (aal) {
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: user.id, role: "authenticated", email: user.email, aal }),
      ]);
    }
    const res = await client.query(text, params);
    await client.query("commit");
    return { rows: res.rows, error: null };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    const err = e as { code?: string; message: string };
    return { rows: [], error: { code: err.code, message: err.message } };
  } finally {
    client.release();
  }
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params);
  return rows[0].n;
}

const requireMfa = (orgId: string, on: boolean) => pool.query(`update public.system_settings set require_mfa = $2 where organisation_id = $1`, [orgId, on]);

interface Fixture {
  orgId: string;
  owner: TestUser;
  admin: TestUser;
  operator: TestUser;
  viewer: TestUser;
}

async function fixture(label: string): Promise<Fixture> {
  const [owner, admin, operator, viewer] = await Promise.all(["owner", "admin", "operator", "viewer"].map((r) => createUser(`${label}-${r}`)));
  const orgId = await bootstrapOrg(owner);
  await addMember(orgId, admin.id, "admin", pool);
  await addMember(orgId, operator.id, "operator", pool);
  await addMember(orgId, viewer.id, "viewer", pool);
  return { orgId, owner, admin, operator, viewer };
}

async function upload(f: Fixture, path: string, docType: string, title: string): Promise<string> {
  const up = await f.owner.client.storage
    .from(DOCUMENT_BUCKET)
    .upload(path, new Blob(["%PDF-1.4\n"], { type: "application/pdf" }), { contentType: "application/pdf" });
  expect(up.error).toBeNull();
  const { data, error } = await f.owner.client.rpc("register_company_document", { p_org: f.orgId, p_doc_type: docType, p_title: title, p_path: path });
  expect(error).toBeNull();
  return data as string;
}

beforeAll(() => {
  pool = testPool();
  worker = testWorker(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("the switch is off by default and changes nothing then", () => {
  it("starts off, and an aal1 session does everything it did before", async () => {
    const f = await fixture("aal-off");
    expect((await pool.query(`select require_mfa from public.system_settings where organisation_id = $1`, [f.orgId])).rows[0].require_mfa).toBe(false);
    const res = await as(f.owner, "aal1", `select public.set_kill_switch($1, true, 'drill')`, [f.orgId]);
    expect(res.error).toBeNull();
    expect((await f.owner.client.rpc("set_kill_switch", { p_org: f.orgId, p_engaged: false, p_reason: "drill over" })).error).toBeNull();
  });
});

describe("private.require_aal2", () => {
  it("raises P0403 for a session below aal2 when the organisation requires MFA, and only then", async () => {
    const f = await fixture("aal-fn");
    for (const aal of ["aal1", "aal2"] as const) expect((await as(f.owner, aal, `select private.require_aal2($1)`, [f.orgId])).error, aal).toBeNull();
    await requireMfa(f.orgId, true);
    const refused = await as(f.owner, "aal1", `select private.require_aal2($1)`, [f.orgId]);
    expect(refused.error?.code).toBe("P0403");
    expect(refused.error?.message).toMatch(/verify with your authenticator/i);
    expect((await as(f.owner, "aal2", `select private.require_aal2($1)`, [f.orgId])).error).toBeNull();
  });

  it("treats a token with no aal claim as aal1", async () => {
    const f = await fixture("aal-noclaim");
    await requireMfa(f.orgId, true);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: f.owner.id, role: "authenticated" })]);
      await expect(client.query(`select private.require_aal2($1)`, [f.orgId])).rejects.toMatchObject({ code: "P0403" });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("does nothing without a signed-in user, so the worker and the service role are unaffected", async () => {
    const f = await fixture("aal-worker");
    await requireMfa(f.orgId, true);
    await expect(pool.query(`select private.require_aal2($1)`, [f.orgId])).resolves.toBeTruthy();
    // A whole workflow still runs with the requirement on: the worker has no session.
    const tender = await createTender(f.owner.client, f.orgId, { reference_number: `AAL-${Date.now()}` });
    const { data: runId, error } = await f.owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    expect(error).toBeNull();
    await drainOrg(worker, pool, f.orgId);
    const { data: approval } = await f.owner.client.from("approvals").select("status").eq("workflow_run_id", runId!).single();
    expect(approval!.status).toBe("PENDING");
  });

  it("is not a way to learn about another organisation: unknown organisations and non-members get the ordinary refusals", async () => {
    const f = await fixture("aal-leak");
    const other = await fixture("aal-leak-other");
    await requireMfa(other.orgId, true);
    // The role check comes first, so a non-member of an organisation that requires MFA is told what they would be told anyway.
    const res = await as(f.owner, "aal1", `select public.set_kill_switch($1, true, 'drill')`, [other.orgId]);
    expect(res.error?.code).toBe("42501");
  });

  it("is closed to the anonymous role and to PUBLIC", async () => {
    const { rows } = await pool.query(
      `select has_function_privilege('anon', 'private.require_aal2(uuid)', 'execute') as anon,
              has_function_privilege('authenticated', 'private.require_aal2(uuid)', 'execute') as authenticated`,
    );
    expect(rows[0]).toEqual({ anon: false, authenticated: true });
  });
});

describe("set_require_mfa", () => {
  it("is for owners only, whatever the session level", async () => {
    const f = await fixture("aal-set-no");
    const outsider = await createUser("aal-set-outsider");
    for (const user of [f.admin, f.operator, f.viewer, outsider]) {
      const res = await as(user, "aal2", `select public.set_require_mfa($1, true)`, [f.orgId]);
      expect(res.error?.code, user.email).toBe("42501");
    }
    expect((await pool.query(`select require_mfa from public.system_settings where organisation_id = $1`, [f.orgId])).rows[0].require_mfa).toBe(false);
  });

  it("needs the owner to be at aal2 now, so an owner who has not enrolled cannot lock the organisation out", async () => {
    const f = await fixture("aal-set-owner");
    const refused = await as(f.owner, "aal1", `select public.set_require_mfa($1, true)`, [f.orgId]);
    expect(refused.error?.code).toBe("P0403");
    expect((await f.owner.client.rpc("set_require_mfa", { p_org: f.orgId, p_on: true } as never)).error?.code).toBe("P0403");
    expect((await pool.query(`select require_mfa from public.system_settings where organisation_id = $1`, [f.orgId])).rows[0].require_mfa).toBe(false);
  });

  it("switches it on from aal2, audits it, and tells every member", async () => {
    const f = await fixture("aal-set-on");
    const res = await as(f.owner, "aal2", `select public.set_require_mfa($1, true)`, [f.orgId]);
    expect(res.error).toBeNull();
    const { rows } = await pool.query(`select require_mfa, updated_by from public.system_settings where organisation_id = $1`, [f.orgId]);
    expect(rows[0]).toEqual({ require_mfa: true, updated_by: f.owner.id });
    const audit = await pool.query(`select actor_user_id from public.audit_logs where organisation_id = $1 and action = 'settings.require_mfa_on'`, [f.orgId]);
    expect(audit.rows).toEqual([{ actor_user_id: f.owner.id }]);
    const notes = await pool.query(`select user_id from public.notifications where organisation_id = $1 and kind = 'MFA_REQUIRED'`, [f.orgId]);
    expect(notes.rows.map((r) => r.user_id).sort()).toEqual([f.owner.id, f.admin.id, f.operator.id, f.viewer.id].sort());
  });

  it("takes aal2 to switch it off too, so a stolen password cannot", async () => {
    const f = await fixture("aal-set-off");
    await requireMfa(f.orgId, true);
    const refused = await as(f.owner, "aal1", `select public.set_require_mfa($1, false)`, [f.orgId]);
    expect(refused.error?.code).toBe("P0403");
    expect((await pool.query(`select require_mfa from public.system_settings where organisation_id = $1`, [f.orgId])).rows[0].require_mfa).toBe(true);
    expect((await as(f.owner, "aal2", `select public.set_require_mfa($1, false)`, [f.orgId])).error).toBeNull();
    expect((await pool.query(`select require_mfa from public.system_settings where organisation_id = $1`, [f.orgId])).rows[0].require_mfa).toBe(false);
    expect(await count(`select 1 from public.audit_logs where organisation_id = $1 and action = 'settings.require_mfa_off'`, [f.orgId])).toBe(1);
  });

  it("revokes browser pairing codes made below aal2 when it goes on, and keeps those made at aal2", async () => {
    const f = await fixture("aal-set-codes");
    const below = await as(f.admin, "aal1", `select public.create_autofill_token($1, 'below')`, [f.orgId]);
    const at = await as(f.owner, "aal2", `select public.create_autofill_token($1, 'at aal2')`, [f.orgId]);
    expect(below.error).toBeNull();
    expect(at.error).toBeNull();
    // A pairing made before the column existed has no recorded level, and counts as below.
    await pool.query(`insert into public.autofill_tokens (organisation_id, user_id, label, token_hash) values ($1, $2, 'legacy', $3)`, [
      f.orgId,
      f.operator.id,
      randomUUID().replaceAll("-", "").repeat(2),
    ]);
    const levels = await pool.query(`select label, created_aal from public.autofill_tokens where organisation_id = $1 order by label`, [f.orgId]);
    expect(levels.rows).toEqual([
      { label: "at aal2", created_aal: "aal2" },
      { label: "below", created_aal: "aal1" },
      { label: "legacy", created_aal: null },
    ]);

    expect((await as(f.owner, "aal2", `select public.set_require_mfa($1, true)`, [f.orgId])).error).toBeNull();
    const after = await pool.query(`select label, revoked_at is not null as revoked from public.autofill_tokens where organisation_id = $1 order by label`, [
      f.orgId,
    ]);
    expect(after.rows).toEqual([
      { label: "at aal2", revoked: false },
      { label: "below", revoked: true },
      { label: "legacy", revoked: true },
    ]);
    const audit = await pool.query(`select metadata from public.audit_logs where organisation_id = $1 and action = 'settings.require_mfa_on'`, [f.orgId]);
    expect(audit.rows[0].metadata).toEqual({ pairing_codes_revoked: 2 });
  });

  it("will not make a pairing code below aal2 while it is on", async () => {
    const f = await fixture("aal-set-pair");
    await requireMfa(f.orgId, true);
    expect((await as(f.operator, "aal1", `select public.create_autofill_token($1, 'x')`, [f.orgId])).error?.code).toBe("P0403");
    expect((await as(f.operator, "aal2", `select public.create_autofill_token($1, 'x')`, [f.orgId])).error).toBeNull();
  });

  it("does not exist for the anonymous or for a missing organisation", async () => {
    const f = await fixture("aal-set-anon");
    expect((await as(f.owner, "aal2", `select public.set_require_mfa($1, true)`, [randomUUID()])).error?.code).toBe("42501");
    expect((await as(f.owner, "aal2", `select public.set_require_mfa($1, null)`, [f.orgId])).error?.code).toBe("23514");
  });
});

describe("every privileged function, with the requirement on", () => {
  it("refuses a session below aal2 with P0403, and lets aal2 through to the function's own checks", async () => {
    const f = await fixture("aal-matrix");
    const other = await createUser("aal-matrix-spare");
    await addMember(f.orgId, other.id, "viewer", pool);

    // Everything the calls need is made first, while the requirement is off.
    const { rows: agents } = await pool.query<{ id: string }>(`select id from public.agents where organisation_id = $1 limit 1`, [f.orgId]);
    const idsDoc = await upload(f, `${f.orgId}/ids/ids.pdf`, "director_ids", "Director IDs");
    const cipcDoc = await upload(f, `${f.orgId}/cipc/cipc.pdf`, "cipc_registration", "CIPC");
    const mailbox = await f.owner.client.rpc("connect_email_account", {
      p_org: f.orgId,
      p_provider: "SMTP",
      p_from: f.owner.email,
      p_display_name: "Owner",
      p_secret: JSON.stringify({ password: "mailbox-password-123" }),
      p_smtp_host: "smtp.acme.co.za",
      p_smtp_port: 587,
      p_smtp_username: f.owner.email,
    });
    expect(mailbox.error).toBeNull();
    const tender = await createTender(f.owner.client, f.orgId, { reference_number: `MX-${Date.now()}` });
    // Bid content for the calls on it (the tender is a simulation, so they stop at their own checks once past the authenticator).
    await pool.query(
      `insert into public.bid_proposal_sections (organisation_id, tender_id, section_key, title, status) values ($1, $2, 'methodology', 'Methodology', 'MISSING_INFORMATION')`,
      [f.orgId, tender.id],
    );
    const { rows: lineRows } = await pool.query(
      `insert into public.bid_pricing_lines (organisation_id, tender_id, source, description) values ($1, $2, 'PERSON', 'A line') returning id`,
      [f.orgId, tender.id],
    );
    const lineId = lineRows[0].id as string;
    const { data: runId } = await f.owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    await drainOrg(worker, pool, f.orgId);
    const { data: approval } = await f.owner.client.from("approvals").select("id").eq("workflow_run_id", runId!).single();
    expect((await f.owner.client.rpc("decide_approval", { p_approval_id: approval!.id, p_approve: true, p_comments: "ok" })).error).toBeNull();
    await drainOrg(worker, pool, f.orgId);
    const { data: submission } = await f.owner.client.from("submission_records").select("id").eq("tender_id", tender.id).single();
    const invite = await f.owner.client.rpc("create_invitation", {
      p_org: f.orgId,
      p_email: `matrix-${randomUUID().slice(0, 8)}@tenderos.test`,
      p_role: "viewer",
    } as never);
    expect(invite.error).toBeNull();
    const invitationId = (invite.data as unknown as Array<{ invitation_id: string }>)[0].invitation_id;

    const o = f.owner;
    const a = f.admin;
    const p = f.operator;
    const calls: Array<[string, TestUser, string, unknown[]]> = [
      ["set_kill_switch", o, `select public.set_kill_switch($1, true, 'x')`, [f.orgId]],
      ["set_agent_control", o, `select public.set_agent_control($1, 'pause', 'x')`, [agents[0].id]],
      ["decide_approval", o, `select public.decide_approval($1, true, 'x')`, [approval!.id]],
      ["set_watched_provinces", a, `select public.set_watched_provinces($1, array['GAUTENG'], false)`, [f.orgId]],
      ["set_watched_methods", a, `select public.set_watched_methods($1, array['EMAIL'])`, [f.orgId]],
      ["register_company_document", p, `select public.register_company_document($1, 'cipc_registration', 'x', 'nope', null)`, [f.orgId]],
      ["verify_company_document", a, `select public.verify_company_document($1)`, [cipcDoc]],
      ["archive_company_document", a, `select public.archive_company_document($1)`, [idsDoc]],
      ["document_download", o, `select * from public.document_download($1)`, [cipcDoc]],
      ["connect_email_account", o, `select public.connect_email_account($1, 'SMTP', 'x@y.co.za', 'x', 'short')`, [f.orgId]],
      ["disconnect_email_account", o, `select public.disconnect_email_account($1)`, [mailbox.data]],
      ["record_bid_delivery", o, `select public.record_bid_delivery($1, 'ref', 'note')`, [submission!.id]],
      ["rerun_bid", p, `select public.rerun_bid($1)`, [tender.id]],
      ["change_tender_delivery", a, `select public.change_tender_delivery($1, '{"source_url":"https://example.org/x"}'::jsonb, 'new link')`, [tender.id]],
      ["create_autofill_token", p, `select public.create_autofill_token($1, 'x')`, [f.orgId]],
      ["change_member_role", o, `select public.change_member_role($1, $2, 'operator')`, [f.orgId, other.id]],
      ["remove_member", o, `select public.remove_member($1, $2)`, [f.orgId, other.id]],
      ["create_invitation", o, `select * from public.create_invitation($1, 'someone-else@tenderos.test', 'viewer')`, [f.orgId]],
      ["resend_invitation", o, `select * from public.resend_invitation($1)`, [invitationId]],
      ["revoke_invitation", o, `select public.revoke_invitation($1)`, [invitationId]],
      ["set_ai_settings", a, `select public.set_ai_settings($1, true, false)`, [f.orgId]],
      ["set_ai_budget", a, `select public.set_ai_budget($1, 6)`, [f.orgId]],
      ["fetch_tender_documents", p, `select public.fetch_tender_documents($1)`, [tender.id]],
      ["save_proposal_section", p, `select public.save_proposal_section($1, 'methodology', 'x', 1)`, [tender.id]],
      ["set_proposal_section_review", p, `select public.set_proposal_section_review($1, 'methodology', true, 1)`, [tender.id]],
      ["save_pricing_line", p, `select public.save_pricing_line($1, 100, 1, null, 1)`, [lineId]],
      ["add_pricing_line", p, `select public.add_pricing_line($1, 'Another line', 'each', 1)`, [tender.id]],
      ["remove_pricing_line", p, `select public.remove_pricing_line($1)`, [lineId]],
      ["set_pricing_confirmed", p, `select public.set_pricing_confirmed($1, true)`, [tender.id]],
    ];

    await requireMfa(f.orgId, true);
    const below: string[] = [];
    for (const [name, user, text, params] of calls) {
      const res = await as(user, "aal1", text, params);
      if (res.error?.code !== "P0403") below.push(`${name}: ${res.error ? `${res.error.code} ${res.error.message}` : "ran"}`);
    }
    expect(below, "these let an aal1 session through").toEqual([]);

    const through: string[] = [];
    for (const [name, user, text, params] of calls) {
      const res = await as(user, "aal2", text, params);
      if (res.error?.code === "P0403") through.push(name);
    }
    expect(through, "these refused an aal2 session").toEqual([]);
  });
});

describe("director IDs, bank letters and proof of address", () => {
  it("are readable by owners and admins only from aal2 while the requirement is on, in Storage and through document_download", async () => {
    const f = await fixture("aal-docs");
    await upload(f, `${f.orgId}/ids/ids.pdf`, "director_ids", "Director IDs");
    await upload(f, `${f.orgId}/cipc/cipc.pdf`, "cipc_registration", "CIPC");
    const read = (user: TestUser, aal: Level, name: string) =>
      as(user, aal, `select private.can_read_document_file($1) as ok`, [name]).then((r) => r.rows[0]?.ok as boolean | undefined);

    // Off: as before.
    expect(await read(f.owner, "aal1", `${f.orgId}/ids/ids.pdf`)).toBe(true);
    expect((await f.owner.client.storage.from(DOCUMENT_BUCKET).download(`${f.orgId}/ids/ids.pdf`)).error).toBeNull();

    await requireMfa(f.orgId, true);
    // On: the restricted file needs aal2 as well as the role; an ordinary one is still a member's to read.
    expect(await read(f.owner, "aal1", `${f.orgId}/ids/ids.pdf`)).toBe(false);
    expect(await read(f.owner, "aal2", `${f.orgId}/ids/ids.pdf`)).toBe(true);
    expect(await read(f.admin, "aal2", `${f.orgId}/ids/ids.pdf`)).toBe(true);
    expect(await read(f.operator, "aal2", `${f.orgId}/ids/ids.pdf`)).toBe(false);
    expect(await read(f.viewer, "aal2", `${f.orgId}/ids/ids.pdf`)).toBe(false);
    expect(await read(f.owner, "aal1", `${f.orgId}/cipc/cipc.pdf`)).toBe(true);
    // The real session (aal1) cannot download the restricted file from Storage any more.
    expect((await f.owner.client.storage.from(DOCUMENT_BUCKET).download(`${f.orgId}/ids/ids.pdf`)).error).not.toBeNull();
    expect((await f.owner.client.storage.from(DOCUMENT_BUCKET).download(`${f.orgId}/cipc/cipc.pdf`)).error).toBeNull();
  });

  it("are not hidden from the service role, which has no session", async () => {
    const f = await fixture("aal-docs-svc");
    await requireMfa(f.orgId, true);
    const { rows } = await pool.query(`select private.aal2_ok($1) as ok`, [f.orgId]);
    expect(rows[0].ok).toBe(true);
  });
});

describe("what did not change", () => {
  it("keeps has_org_role's signature", async () => {
    const { rows } = await pool.query(
      `select pg_get_function_identity_arguments(p.oid) as args from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname = 'has_org_role'`,
    );
    expect(rows).toEqual([{ args: "p_org uuid, p_roles org_role[]" }]);
  });

  it("does not gate the actions operators and the worker rely on", async () => {
    const f = await fixture("aal-open");
    await requireMfa(f.orgId, true);
    // Starting and cancelling workflows, retrying tasks and creating tenders stay open to an aal1 session.
    const tender = await createTender(f.operator.client, f.orgId, { reference_number: `OPEN-${Date.now()}` });
    expect((await f.operator.client.rpc("start_tender_workflow", { p_tender_id: tender.id })).error).toBeNull();
    // Viewers can still read.
    expect((await f.viewer.client.from("tenders").select("id")).data).toHaveLength(1);
    expect((await as(f.viewer, "aal1", `select count(*)::int as n from public.tenders where organisation_id = $1`, [f.orgId])).rows[0].n).toBe(1);
  });
});
