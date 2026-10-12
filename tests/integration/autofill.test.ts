import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "@/lib/db/pool";
import type { Worker } from "@/workflows/worker";
import { DOCUMENT_BUCKET } from "@/lib/domain/documents";
import type { AutofillPayload } from "@/lib/autofill/format";
import { addMember, admin, bootstrapOrg, createTender, createUser, drainOrg, testPool, testWorker, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));

let pool: Pool;
let worker: Worker;
let owner: TestUser;
let adminUser: TestUser;
let operator: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let orgId: string;
let outsiderOrg: string;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const PDF = "%PDF-1.4\n% TenderOS autofill test\n";

async function createToken(user: TestUser, label = "Test browser", org = orgId) {
  return user.client.rpc("create_autofill_token", { p_org: org, p_label: label });
}

async function resolve(token: string) {
  const { data, error } = await admin().rpc("resolve_autofill_token", { p_hash: sha256(token) });
  expect(error).toBeNull();
  return data ?? [];
}

async function addDocument(user: TestUser, docType: string, title: string, expiresAt?: string, org = orgId) {
  const path = `${org}/${randomUUID()}/${docType}.pdf`;
  const up = await user.client.storage.from(DOCUMENT_BUCKET).upload(path, new Blob([PDF], { type: "application/pdf" }), { contentType: "application/pdf" });
  expect(up.error).toBeNull();
  const { data, error } = await user.client.rpc("register_company_document", {
    p_org: org,
    p_doc_type: docType,
    p_title: title,
    p_path: path,
    p_expires_at: expiresAt,
  });
  expect(error).toBeNull();
  return data as string;
}

function bearer(token: string | null, path: string) {
  return new Request(`http://localhost:3000${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

beforeAll(async () => {
  pool = testPool();
  worker = testWorker(pool);
  owner = await createUser("fill-owner");
  adminUser = await createUser("fill-admin");
  operator = await createUser("fill-operator");
  viewer = await createUser("fill-viewer");
  outsider = await createUser("fill-outsider");
  orgId = await bootstrapOrg(owner);
  await addMember(orgId, adminUser.id, "admin", pool);
  await addMember(orgId, operator.id, "operator", pool);
  await addMember(orgId, viewer.id, "viewer", pool);
  outsiderOrg = await bootstrapOrg(outsider);
});

afterAll(async () => {
  await pool.end();
});

describe("browser helper pairing codes", () => {
  it("lets owners, admins and operators create a code, and refuses viewers and outsiders", async () => {
    for (const u of [owner, adminUser, operator]) {
      const { data, error } = await createToken(u);
      expect(error).toBeNull();
      expect(data).toMatch(/^tos_[a-f0-9]{64}$/);
    }
    const refused = await createToken(viewer);
    expect(refused.error?.message).toMatch(/Only owners, admins and operators/);
    expect((await createToken(outsider)).error).not.toBeNull();
    expect((await outsider.client.rpc("create_autofill_token", { p_org: orgId })).error).not.toBeNull();

    const { rows } = await pool.query(`select action, actor_user_id from public.audit_logs where organisation_id = $1 and action = 'autofill.token_created'`, [
      orgId,
    ]);
    expect(rows.map((r) => r.actor_user_id).sort()).toEqual([owner.id, adminUser.id, operator.id].sort());
  });

  it("stores only the hash, which browsers cannot read", async () => {
    const { data: token } = await createToken(owner, "  Office laptop  ");
    const { rows } = await pool.query(`select * from public.autofill_tokens where token_hash = $1`, [sha256(token!)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organisation_id: orgId, user_id: owner.id, label: "Office laptop", revoked_at: null });
    expect(JSON.stringify(rows[0])).not.toContain(token!);
    expect(JSON.stringify(rows[0])).not.toContain(token!.slice(4));
    const expiresInDays = (new Date(rows[0].expires_at).getTime() - Date.now()) / 86_400_000;
    expect(expiresInDays).toBeGreaterThan(29.9);
    expect(expiresInDays).toBeLessThanOrEqual(30);
    const { rows: audit } = await pool.query(`select metadata::text as m from public.audit_logs where organisation_id = $1 and action like 'autofill.%'`, [
      orgId,
    ]);
    for (const a of audit) expect(a.m).not.toContain(token!.slice(4));

    expect((await owner.client.from("autofill_tokens").select("token_hash")).error).not.toBeNull();
    expect((await owner.client.from("autofill_tokens").select("*")).error).not.toBeNull();
    const { data: mine, error } = await owner.client.from("autofill_tokens").select("id, user_id, label, last_used_at, expires_at, revoked_at");
    expect(error).toBeNull();
    expect(mine!.length).toBe(2);
    expect(mine!.every((r) => r.user_id === owner.id)).toBe(true);
    // Members see only their own codes, even owners and admins.
    const { data: theirs } = await adminUser.client.from("autofill_tokens").select("id, user_id").eq("organisation_id", orgId);
    expect(theirs!.every((r) => r.user_id === adminUser.id)).toBe(true);
    expect((await outsider.client.from("autofill_tokens").select("id").eq("organisation_id", orgId)).data).toEqual([]);

    expect(
      (await owner.client.from("autofill_tokens").insert({ organisation_id: orgId, user_id: owner.id, label: "x", token_hash: "0".repeat(64) } as never)).error,
    ).not.toBeNull();
    expect(
      (
        await owner.client
          .from("autofill_tokens")
          .update({ expires_at: "2099-01-01T00:00:00Z" } as never)
          .eq("user_id", owner.id)
      ).error,
    ).not.toBeNull();
    const del = await owner.client.from("autofill_tokens").delete().eq("user_id", owner.id).select("id");
    expect(del.error !== null || (del.data ?? []).length === 0).toBe(true);
    const { rows: still } = await pool.query(`select count(*)::int as n from public.autofill_tokens where user_id = $1`, [owner.id]);
    expect(still[0].n).toBe(2);
  });

  it("resolves a code only through the service role", async () => {
    const { data: token } = await createToken(operator, "Resolve test");
    expect((await operator.client.rpc("resolve_autofill_token", { p_hash: sha256(token!) })).error).not.toBeNull();

    const [row] = await resolve(token!);
    expect(row).toMatchObject({ organisation_id: orgId, user_id: operator.id, role: "operator" });
    const { rows } = await pool.query(`select last_used_at from public.autofill_tokens where id = $1`, [row.token_id]);
    expect(rows[0].last_used_at).not.toBeNull();

    expect(await resolve(`tos_${"0".repeat(64)}`)).toEqual([]);
    expect((await admin().rpc("resolve_autofill_token", { p_hash: "not-a-hash" })).data).toEqual([]);
    expect((await admin().rpc("resolve_autofill_token", { p_hash: token! })).data).toEqual([]);
  });

  it("stops working when revoked, by its owner or an owner/admin only", async () => {
    const { data: token } = await createToken(operator, "Revoke test");
    const [row] = await resolve(token!);
    expect((await viewer.client.rpc("revoke_autofill_token", { p_id: row.token_id })).error).not.toBeNull();
    expect((await outsider.client.rpc("revoke_autofill_token", { p_id: row.token_id })).error).not.toBeNull();
    expect((await operator.client.rpc("revoke_autofill_token", { p_id: row.token_id })).error).toBeNull();
    expect(await resolve(token!)).toEqual([]);
    expect((await operator.client.rpc("revoke_autofill_token", { p_id: row.token_id })).error).not.toBeNull();

    const { data: second } = await createToken(operator, "Admin revokes");
    const [r2] = await resolve(second!);
    const { data: ownerToken } = await createToken(owner, "Not the operator's");
    const [r3] = await resolve(ownerToken!);
    expect((await operator.client.rpc("revoke_autofill_token", { p_id: r3.token_id })).error).not.toBeNull();
    expect((await adminUser.client.rpc("revoke_autofill_token", { p_id: r2.token_id })).error).toBeNull();
    expect(await resolve(second!)).toEqual([]);
    expect(await resolve(ownerToken!)).toHaveLength(1);

    const { rows } = await pool.query(
      `select actor_user_id from public.audit_logs where organisation_id = $1 and action = 'autofill.token_revoked' order by created_at`,
      [orgId],
    );
    expect(rows.map((r) => r.actor_user_id)).toEqual([operator.id, adminUser.id]);
  });

  it("respects expiry and the member's current role", async () => {
    const { data: token } = await createToken(adminUser, "Expiry test");
    const [row] = await resolve(token!);
    await pool.query(`update public.autofill_tokens set created_at = now() - interval '31 days', expires_at = now() - interval '1 second' where id = $1`, [
      row.token_id,
    ]);
    expect(await resolve(token!)).toEqual([]);
    expect((await admin().rpc("autofill_documents", { p_token_id: row.token_id })).data).toEqual([]);

    const { data: demoted } = await createToken(adminUser, "Demotion test");
    expect(await resolve(demoted!)).toHaveLength(1);
    await pool.query(`update public.organisation_members set role = 'viewer' where organisation_id = $1 and user_id = $2`, [orgId, adminUser.id]);
    expect(await resolve(demoted!)).toEqual([]);
    await pool.query(`update public.organisation_members set role = 'admin' where organisation_id = $1 and user_id = $2`, [orgId, adminUser.id]);
    expect(await resolve(demoted!)).toHaveLength(1);
  });

  it("is deleted when the member leaves the organisation", async () => {
    const leaver = await createUser("fill-leaver");
    await addMember(orgId, leaver.id, "operator", pool);
    const { data: token } = await createToken(leaver, "Leaver");
    expect(await resolve(token!)).toHaveLength(1);
    await pool.query(`delete from public.organisation_members where organisation_id = $1 and user_id = $2`, [orgId, leaver.id]);
    expect(await resolve(token!)).toEqual([]);
    const { rows } = await pool.query(`select count(*)::int as n from public.autofill_tokens where user_id = $1`, [leaver.id]);
    expect(rows[0].n).toBe(0);
  });

  it("allows at most 5 active codes per member", async () => {
    const capped = await createUser("fill-capped");
    await addMember(orgId, capped.id, "operator", pool);
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { data, error } = await createToken(capped, `Browser ${i + 1}`);
      expect(error).toBeNull();
      tokens.push(data!);
    }
    const sixth = await createToken(capped, "Browser 6");
    expect(sixth.error?.message).toMatch(/5 active pairing codes/);

    const [first] = await resolve(tokens[0]);
    expect((await capped.client.rpc("revoke_autofill_token", { p_id: first.token_id })).error).toBeNull();
    expect((await createToken(capped, "Browser 6")).error).toBeNull();

    // Expired codes no longer count.
    const [second] = await resolve(tokens[1]);
    await pool.query(`update public.autofill_tokens set created_at = now() - interval '31 days', expires_at = now() - interval '1 second' where id = $1`, [
      second.token_id,
    ]);
    expect((await createToken(capped, "Browser 7")).error).toBeNull();
    expect((await createToken(capped, "Browser 8")).error?.message).toMatch(/5 active pairing codes/);
  });

  it("rate-limits by an explicit key for the service role only", async () => {
    const key = `autofill_token:${randomUUID()}`;
    expect((await owner.client.rpc("hit_rate_limit_key", { p_key: key, p_action: "autofill.test", p_max: 2, p_window_seconds: 60 })).error).not.toBeNull();
    expect((await admin().rpc("hit_rate_limit_key", { p_key: key, p_action: "autofill.test", p_max: 2, p_window_seconds: 60 })).error).toBeNull();
    expect((await admin().rpc("hit_rate_limit_key", { p_key: key, p_action: "autofill.test", p_max: 2, p_window_seconds: 60 })).error).toBeNull();
    const third = await admin().rpc("hit_rate_limit_key", { p_key: key, p_action: "autofill.test", p_max: 2, p_window_seconds: 60 });
    expect(third.error?.code).toBe("P0429");
    expect((await admin().rpc("hit_rate_limit_key", { p_key: owner.id, p_action: "autofill.test" })).error?.code).toBe("23514");
  });
});

describe("browser helper API", () => {
  let ownerToken: string;
  let operatorToken: string;
  let ids: Record<string, string>;

  beforeAll(async () => {
    ids = {
      cipc: await addDocument(owner, "cipc_registration", "CIPC CoR 14.3"),
      csd: await addDocument(owner, "csd_registration", "CSD summary report"),
      tax: await addDocument(owner, "tax_compliance", "TCS PIN letter", inDays(200)),
      sbd: await addDocument(owner, "sbd_declarations", "Signed SBD forms"),
      bank: await addDocument(owner, "bank_confirmation", "Bank letter"),
      expired: await addDocument(owner, "insurance", "Old insurance", inDays(-2)),
      unverified: await addDocument(operator, "coida", "COIDA letter (unverified)"),
      archived: await addDocument(owner, "company_profile_doc", "Old profile"),
      foreign: await addDocument(outsider, "cipc_registration", "Outsider CIPC", undefined, outsiderOrg),
    };
    expect((await owner.client.rpc("archive_company_document", { p_id: ids.archived })).error).toBeNull();
    const profile = await owner.client.from("company_profiles").upsert(
      {
        organisation_id: orgId,
        legal_name: "Acme Trading (Pty) Ltd",
        registration_number: "2015/123456/07",
        csd_number: "MAAA0123456",
        bbbee_level: 2,
        contact_email: "tenders@acme.co.za",
        authorised_signatory: "Thandi Mokoena",
      },
      { onConflict: "organisation_id" },
    );
    expect(profile.error).toBeNull();
    ownerToken = (await createToken(owner, "API owner")).data!;
    operatorToken = (await createToken(operator, "API operator")).data!;
  });

  it("refuses a missing, malformed, unknown or revoked code with a bare 401 and no CORS headers", async () => {
    const { GET } = await import("@/app/api/autofill/profile/route");
    for (const token of [null, "nonsense", `tos_${"a".repeat(64)}`]) {
      const res = await GET(bearer(token, "/api/autofill/profile"));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    const { data: temp } = await createToken(owner, "Revoked API");
    const [row] = await resolve(temp!);
    await owner.client.rpc("revoke_autofill_token", { p_id: row.token_id });
    expect((await GET(bearer(temp!, "/api/autofill/profile"))).status).toBe(401);
  });

  it("returns the profile with nulls for missing facts and only the documents the role allows", async () => {
    const { GET } = await import("@/app/api/autofill/profile/route");
    const res = await GET(bearer(operatorToken, "/api/autofill/profile"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res.json()) as AutofillPayload;
    expect(body.member.role).toBe("operator");
    expect(body.profile).toMatchObject({
      legal_name: "Acme Trading (Pty) Ltd",
      csd_number: "MAAA0123456",
      bbbee_level: 2,
      vat_number: null,
      tax_pin: null,
      physical_address: null,
      website: null,
    });
    expect(Object.keys(body.profile)).toHaveLength(17);
    const docIds = body.documents.map((d) => d.id).sort();
    expect(docIds).toEqual([ids.cipc, ids.csd, ids.tax, ids.sbd].sort());
    expect(Object.keys(body.documents[0]).sort()).toEqual(["doc_type", "expires_at", "file_name", "id", "mime_type", "size_bytes", "title"]);
    expect(JSON.stringify(body)).not.toContain("storage_path");

    const asOwner = (await (await GET(bearer(ownerToken, "/api/autofill/profile"))).json()) as AutofillPayload;
    expect(asOwner.documents.map((d) => d.id).sort()).toEqual([ids.cipc, ids.csd, ids.tax, ids.sbd, ids.bank].sort());
  });

  it("streams an allowed document with safe headers and audits the download", async () => {
    const { GET } = await import("@/app/api/autofill/documents/[id]/route");
    const call = (token: string | null, id: string) => GET(bearer(token, `/api/autofill/documents/${id}`), { params: Promise.resolve({ id }) });

    const res = await call(operatorToken, ids.cipc);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PDF);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="cipc_registration\.pdf"/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();

    const { rows } = await pool.query(
      `select actor_type, actor_user_id, metadata from public.audit_logs where organisation_id = $1 and action = 'document.autofill_download' and resource_id = $2`,
      [orgId, ids.cipc],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "user", actor_user_id: operator.id, metadata: { doc_type: "cipc_registration", via: "browser_helper" } });

    for (const id of [ids.bank, ids.expired, ids.unverified, ids.archived, ids.foreign, randomUUID()]) {
      expect((await call(operatorToken, id)).status, id).toBe(404);
    }
    expect((await call(operatorToken, "not-a-uuid")).status).toBe(404);
    expect((await call(null, ids.cipc)).status).toBe(401);
    expect((await call(ownerToken, ids.bank)).status).toBe(200);
    const { rows: denied } = await pool.query(
      `select count(*)::int as n from public.audit_logs where organisation_id = $1 and action = 'document.autofill_download' and resource_id <> all($2)`,
      [orgId, [ids.cipc, ids.bank]],
    );
    expect(denied[0].n).toBe(0);
  });

  it("lists approved real bids awaiting delivery with their bid pack attachments", async () => {
    const tender = await createTender(owner.client, orgId, {
      is_simulation: false,
      reference_number: `FILL-${Date.now()}`,
      submission_method: "ELECTRONIC_PORTAL",
      source_url: "https://www.etenders.gov.za/example",
    });
    const started = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    expect(started.error).toBeNull();
    await drainOrg(worker, pool, orgId);
    const { data: approval } = await owner.client.from("approvals").select("id").eq("workflow_run_id", started.data!).single();
    expect((await owner.client.rpc("decide_approval", { p_approval_id: approval!.id, p_approve: true, p_comments: "Deliver it" })).error).toBeNull();
    await drainOrg(worker, pool, orgId);
    const { data: sub } = await owner.client.from("submission_records").select("id, status").eq("workflow_run_id", started.data!).single();
    expect(sub!.status).toBe("ACTION_REQUIRED");

    const { GET } = await import("@/app/api/autofill/profile/route");
    const body = (await (await GET(bearer(operatorToken, "/api/autofill/profile"))).json()) as AutofillPayload;
    const bid = body.bids.find((b) => b.submission_id === sub!.id);
    expect(bid).toBeDefined();
    expect(bid!.tender).toMatchObject({
      id: tender.id,
      reference_number: tender.reference_number,
      submission_method: "ELECTRONIC_PORTAL",
      source_url: "https://www.etenders.gov.za/example",
    });
    expect(bid!.attachments.length).toBeGreaterThan(0);
    for (const a of bid!.attachments) {
      expect(a.available).toBe(body.documents.some((d) => d.id === a.document_id));
    }
    expect(bid!.attachments.map((a) => a.document_id)).toContain(ids.cipc);

    // Once a person records the delivery, the bid is no longer offered.
    expect((await owner.client.rpc("record_bid_delivery", { p_submission_id: sub!.id, p_reference: "PORTAL-1" })).error).toBeNull();
    const after = (await (await GET(bearer(operatorToken, "/api/autofill/profile"))).json()) as AutofillPayload;
    expect(after.bids.find((b) => b.submission_id === sub!.id)).toBeUndefined();
  });
});

describe("Apply with TenderOS", () => {
  let ownerToken: string;
  let operatorToken: string;
  let tenderId: string;
  let submissionId: string;
  let docs: Record<"cipc" | "tax" | "ids" | "bank", string>;

  const planCall = (token: string | null, id: string, query = "") =>
    import("@/app/api/autofill/tenders/[id]/apply-plan/route").then(({ GET }) =>
      GET(bearer(token, `/api/autofill/tenders/${id}/apply-plan${query}`), { params: Promise.resolve({ id }) }),
    );
  const reportCall = (token: string | null, id: string, body: unknown, contentType: string | null = "application/json") =>
    import("@/app/api/autofill/tenders/[id]/apply-report/route").then(({ POST }) =>
      POST(
        new Request(`http://localhost:3000/api/autofill/tenders/${id}/apply-report`, {
          method: "POST",
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(contentType ? { "Content-Type": contentType } : {}) },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
        { params: Promise.resolve({ id }) },
      ),
    );
  const REPORT = { host: "www.etenders.gov.za", fields: 9, documents: 2, left: 4, sensitive: false, confirmed_host: false };

  beforeAll(async () => {
    docs = {
      cipc: await addDocument(owner, "cipc_registration", "Apply CIPC"),
      tax: await addDocument(owner, "tax_compliance", "Apply TCS", inDays(200)),
      ids: await addDocument(owner, "director_ids", "Apply director IDs"),
      bank: await addDocument(owner, "bank_confirmation", "Apply bank letter"),
    };
    ownerToken = (await createToken(owner, "Apply owner")).data!;
    operatorToken = (await createToken(operator, "Apply operator")).data!;
    const profile = await owner.client
      .from("company_profiles")
      .upsert({ organisation_id: orgId, legal_name: "Acme Trading (Pty) Ltd", csd_number: "MAAA0123456" }, { onConflict: "organisation_id" });
    expect(profile.error).toBeNull();

    const tender = await createTender(owner.client, orgId, {
      is_simulation: false,
      reference_number: `APPLY-${Date.now()}`,
      submission_method: "ELECTRONIC_PORTAL",
      submission_destination: "https://www.etenders.gov.za (eSubmission)",
      source_url: "https://www.etenders.gov.za/home/Download?blobName=x.pdf",
    });
    tenderId = tender.id;
    const started = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    expect(started.error).toBeNull();
    await drainOrg(worker, pool, orgId);
    const { data: approval } = await owner.client.from("approvals").select("id").eq("workflow_run_id", started.data!).single();
    expect((await owner.client.rpc("decide_approval", { p_approval_id: approval!.id, p_approve: true, p_comments: "Apply" })).error).toBeNull();
    await drainOrg(worker, pool, orgId);
    const { data: sub } = await owner.client.from("submission_records").select("id, status").eq("workflow_run_id", started.data!).single();
    expect(sub!.status).toBe("ACTION_REQUIRED");
    submissionId = sub!.id;
    // A known bid pack: two ordinary documents and two personal ones.
    const pack = [
      { key: "cipc", label: "CIPC registration", document_id: docs.cipc },
      { key: "tax", label: "SARS tax compliance", document_id: docs.tax },
      { key: "ids", label: "Director IDs", document_id: docs.ids },
      { key: "bank", label: "Bank letter", document_id: docs.bank },
    ];
    await pool.query(
      `update public.tasks set output = jsonb_set(output, '{attachments}', $2::jsonb) where workflow_run_id = $1 and type = 'submission.execute' and status = 'COMPLETED'`,
      [started.data!, JSON.stringify(pack)],
    );
  });

  it("refuses a missing, malformed or revoked code and a tender that is not a uuid", async () => {
    expect((await planCall(null, tenderId)).status).toBe(401);
    expect((await planCall("nonsense", tenderId)).status).toBe(401);
    expect((await planCall(ownerToken, "not-a-uuid")).status).toBe(404);
    // The owner already holds the maximum of five active codes by now, so use
    // a member with room.
    const { data: temp } = await createToken(adminUser, "Revoked apply");
    const [row] = await resolve(temp!);
    await adminUser.client.rpc("revoke_autofill_token", { p_id: row.token_id });
    expect((await planCall(temp!, tenderId)).status).toBe(401);
    expect((await reportCall(temp!, tenderId, REPORT)).status).toBe(401);
  });

  it("returns the portal, the facts and only the bid pack documents the role may attach", async () => {
    const res = await planCall(operatorToken, tenderId);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const plan = await res.json();
    expect(plan).toMatchObject({
      version: 1,
      submission_id: submissionId,
      portal: { url: "https://www.etenders.gov.za/", host: "www.etenders.gov.za" },
      member: { role: "operator" },
      include_sensitive: false,
    });
    expect(plan.tender.id).toBe(tenderId);
    expect(plan.profile.legal_name).toBe("Acme Trading (Pty) Ltd");
    expect(plan.profile.vat_number).toBeNull();
    expect(plan.documents.map((d: { id: string }) => d.id).sort()).toEqual([docs.cipc, docs.tax].sort());
    expect(plan.skipped_documents.map((s: { label: string }) => s.label).sort()).toEqual(["Bank letter", "Director IDs"]);
    expect(JSON.stringify(plan)).not.toContain("storage_path");

    // An operator asking for personal documents still does not get them.
    const asked = await (await planCall(operatorToken, tenderId, "?sensitive=1")).json();
    expect(asked.include_sensitive).toBe(false);
    expect(asked.documents.some((d: { sensitive: boolean }) => d.sensitive)).toBe(false);
  });

  it("includes personal documents only for an owner or admin who ticks the option", async () => {
    const off = await (await planCall(ownerToken, tenderId)).json();
    expect(off.include_sensitive).toBe(false);
    expect(off.documents.map((d: { id: string }) => d.id).sort()).toEqual([docs.cipc, docs.tax].sort());
    expect(off.skipped_documents).toEqual(
      expect.arrayContaining([
        { label: "Director IDs", reason: "sensitive_not_requested" },
        { label: "Bank letter", reason: "sensitive_not_requested" },
      ]),
    );

    const on = await (await planCall(ownerToken, tenderId, "?sensitive=1")).json();
    expect(on.include_sensitive).toBe(true);
    expect(on.documents.map((d: { id: string }) => d.id).sort()).toEqual([docs.cipc, docs.tax, docs.ids, docs.bank].sort());
    expect(on.documents.filter((d: { sensitive: boolean }) => d.sensitive)).toHaveLength(2);
  });

  it("does not reveal tenders of other organisations or tenders with no approved bid waiting", async () => {
    const other = await createTender(outsider.client, outsiderOrg, { is_simulation: false });
    expect((await planCall(ownerToken, other.id)).status).toBe(404);
    const idle = await createTender(owner.client, orgId, { is_simulation: false, reference_number: `IDLE-${Date.now()}` });
    const res = await planCall(ownerToken, idle.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no approved bid waiting/);
  });

  it("says plainly when the tender has no portal address the helper can open", async () => {
    await pool.query(`update public.tenders set submission_destination = 'Hand delivery at the municipal offices', source_url = null where id = $1`, [
      tenderId,
    ]);
    const res = await planCall(ownerToken, tenderId);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/web address/);
    await pool.query(`update public.tenders set submission_destination = 'https://www.etenders.gov.za (eSubmission)' where id = $1`, [tenderId]);
    expect((await planCall(ownerToken, tenderId)).status).toBe(200);
  });

  it("records a report as an audit event and a tender event, with counts and host only", async () => {
    const res = await reportCall(operatorToken, tenderId, REPORT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const { rows: audit } = await pool.query(
      `select actor_type, actor_user_id, resource_type, metadata from public.audit_logs
        where organisation_id = $1 and action = 'autofill.form_prepared' and resource_id = $2`,
      [orgId, tenderId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: "user",
      actor_user_id: operator.id,
      resource_type: "tender",
      metadata: { host: "www.etenders.gov.za", fields: 9, documents: 2, left: 4, sensitive: false, confirmed_host: false, via: "browser_helper" },
    });
    const { rows: events } = await pool.query(
      `select event_type, actor_user_id, summary, payload from public.agent_events where organisation_id = $1 and tender_id = $2 and event_type = 'BID_FORM_PREPARED'`,
      [orgId, tenderId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_user_id: operator.id, payload: { fields: 9, documents: 2 } });
    expect(events[0].summary).toMatch(/9 fields, 2 documents/);
    // Members read the event through RLS; it carries no field values.
    const { data: visible } = await viewer.client
      .from("agent_events")
      .select("event_type, payload")
      .eq("tender_id", tenderId)
      .eq("event_type", "BID_FORM_PREPARED");
    expect(visible).toHaveLength(1);
  });

  it("refuses bad reports and reports it should not accept", async () => {
    expect((await reportCall(null, tenderId, REPORT)).status).toBe(401);
    expect((await reportCall(operatorToken, tenderId, REPORT, "text/plain")).status).toBe(415);
    expect((await reportCall(operatorToken, tenderId, "{not json")).status).toBe(422);
    expect((await reportCall(operatorToken, tenderId, { ...REPORT, fields: -1 })).status).toBe(422);
    expect((await reportCall(operatorToken, tenderId, { ...REPORT, file_names: ["ids.pdf"] })).status).toBe(422);
    expect((await reportCall(operatorToken, tenderId, { ...REPORT, host: "https://evil.example/" })).status).toBe(422);
    expect((await reportCall(operatorToken, "not-a-uuid", REPORT)).status).toBe(404);
    expect((await reportCall(operatorToken, tenderId, "x".repeat(5000))).status).toBe(413);
    // Personal documents are an owner/admin choice.
    expect((await reportCall(operatorToken, tenderId, { ...REPORT, sensitive: true })).status).toBe(403);
    expect((await reportCall(ownerToken, tenderId, { ...REPORT, sensitive: true })).status).toBe(200);
    // Another organisation's tender, and a tender with no bid waiting, record nothing.
    const other = await createTender(outsider.client, outsiderOrg, { is_simulation: false });
    expect((await reportCall(ownerToken, other.id, REPORT)).status).toBe(409);
    const { rows } = await pool.query(`select count(*)::int as n from public.audit_logs where action = 'autofill.form_prepared' and resource_id = $1`, [
      other.id,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it("is rate-limited inside the database per pairing code", async () => {
    const { data: token } = await createToken(adminUser, "Report limit");
    const [row] = await resolve(token!);
    let limited = false;
    for (let i = 0; i < 25 && !limited; i++) {
      const r = await admin().rpc("autofill_record_prepared", {
        p_token_id: row.token_id,
        p_tender_id: tenderId,
        p_host: "www.etenders.gov.za",
        p_fields: 1,
        p_documents: 0,
        p_left: 0,
        p_sensitive: false,
        p_confirmed_host: false,
      });
      if (r.error?.code === "P0429") limited = true;
      else expect(r.error).toBeNull();
    }
    expect(limited).toBe(true);
    // Browsers cannot call it at all.
    expect(
      (
        await owner.client.rpc("autofill_record_prepared", {
          p_token_id: row.token_id,
          p_tender_id: tenderId,
          p_host: "www.etenders.gov.za",
          p_fields: 1,
          p_documents: 0,
          p_left: 0,
          p_sensitive: false,
          p_confirmed_host: false,
        })
      ).error,
    ).not.toBeNull();
  });
});
