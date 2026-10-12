import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import { addMember, bootstrapOrg, createUser, testPool, type TestUser } from "./helpers";

let pool: Pool;
let owner: TestUser;
let member: TestUser;
let orgId: string;

/** True when some index on the table starts with exactly these columns, in this order (and, if `full`, is not a partial index). */
async function hasIndexStartingWith(table: string, columns: string[], full = false): Promise<boolean> {
  const { rows } = await pool.query<{ cols: string[] }>(
    `select array_agg(a.attname order by k.ord)::text[] as cols
       from pg_index i
       join pg_class c on c.oid = i.indrelid
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       cross join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
       join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
      where c.relname = $1 and i.indisvalid and (not $2 or i.indpred is null)
      group by i.indexrelid`,
    [table, full],
  );
  return rows.some((r) => columns.every((col, i) => r.cols[i] === col));
}

beforeAll(async () => {
  pool = testPool();
  owner = await createUser("hyg-owner");
  member = await createUser("hyg-member");
  orgId = await bootstrapOrg(owner);
  await addMember(orgId, member.id, "operator", pool);
});

afterAll(async () => {
  await pool.end();
});

describe("indexes for the hot paths", () => {
  // [table, leading columns, whether a partial index will not do]
  const expected: Array<[string, string[], boolean?]> = [
    // Looked up when a task is followed or deleted, and listed on the tender page.
    ["handoffs", ["to_task_id"]],
    ["handoffs", ["from_task_id"]],
    ["handoffs", ["tender_id", "created_at"]],
    ["approvals", ["task_id"], true], // the unique index on pending approvals is partial and cannot serve a lookup by task
    ["approvals", ["tender_id", "requested_at"]],
    ["approvals", ["workflow_run_id"]],
    ["workflow_runs", ["tender_id", "created_at"]],
    ["tenders", ["organisation_id", "status", "closing_at"]],
    ["notifications", ["user_id", "created_at"]],
    // Foreign keys that were unindexed: deleting the parent scanned the whole child table.
    ["jobs", ["organisation_id"]],
    ["submission_records", ["approval_id"]],
    ["submission_records", ["workflow_run_id"]],
    ["submission_records", ["organisation_id"]],
    ["notifications", ["organisation_id"]],
    ["task_dependencies", ["depends_on_task_id"]],
    ["task_dependencies", ["organisation_id"]],
    ["tasks", ["parent_task_id"]],
    ["tasks", ["approval_id"]],
    ["email_messages", ["email_account_id"]],
    ["cost_usage", ["task_id"]],
    ["cost_usage", ["workflow_run_id"]],
    ["cost_usage", ["agent_id"]],
    // So erasing a person does not scan every table that names them.
    ["tenders", ["created_by"]],
    ["workflow_runs", ["started_by"]],
    ["approvals", ["decided_by"]],
    ["email_messages", ["sent_by"]],
    ["email_accounts", ["user_id"]],
    ["autofill_tokens", ["user_id"]],
    ["company_documents", ["uploaded_by"]],
    ["company_documents", ["verified_by"]],
  ];

  it.each(expected)("%s is indexed on %j", async (table, columns, full) => {
    expect(await hasIndexStartingWith(table, columns, full ?? false), `${table}(${columns.join(", ")})`).toBe(true);
  });

  it("does not keep the narrower tender index the new one makes redundant", async () => {
    const { rows } = await pool.query(`select 1 from pg_indexes where schemaname = 'public' and indexname = 'tenders_org_status_idx'`);
    expect(rows).toEqual([]);
  });
});

describe("notifications", () => {
  it("are readable only by a person who still belongs to the organisation", async () => {
    await pool.query(
      `insert into public.notifications (organisation_id, user_id, kind, title) values ($1, $2, 'TEST_NOTE', 'Before leaving'), ($1, $2, 'TEST_NOTE', 'Also before')`,
      [orgId, member.id],
    );
    const before = await member.client.from("notifications").select("id").eq("organisation_id", orgId);
    expect(before.data).toHaveLength(2);

    await pool.query(`delete from public.organisation_members where organisation_id = $1 and user_id = $2`, [orgId, member.id]);
    const after = await member.client.from("notifications").select("id").eq("organisation_id", orgId);
    expect(after.error).toBeNull();
    expect(after.data).toEqual([]);
    // They are still the person's own rows, and nobody else sees them.
    const { rows } = await pool.query(`select count(*)::int as n from public.notifications where user_id = $1`, [member.id]);
    expect(rows[0].n).toBe(2);
    expect((await owner.client.from("notifications").select("id").eq("user_id", member.id)).data).toEqual([]);
  });
});

describe("private functions", () => {
  it("are not executable by everyone: only what the API roles need has an explicit grant", async () => {
    const { rows } = await pool.query<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
         from pg_proc p
        where p.pronamespace = 'private'::regnamespace
          and has_function_privilege('anon', p.oid, 'execute')`,
    );
    expect(rows.map((r) => r.fn)).toEqual([]);
  });

  it.each(["private.limit_tender_creation()", "private.stamp_company_profile()", "private.storage_path_org(text)", "private.valid_keywords(text[])"])(
    "%s is not executable by PUBLIC",
    async (fn) => {
      const { rows } = await pool.query(
        `select has_function_privilege('anon', $1::regprocedure, 'execute') as anon, has_function_privilege('authenticated', $1::regprocedure, 'execute') as auth`,
        [fn],
      );
      expect(rows[0].anon).toBe(false);
      // The two that run under the caller's rights (a check constraint, a storage policy) are granted on purpose.
      expect(rows[0].auth).toBe(fn.includes("storage_path_org") || fn.includes("valid_keywords"));
    },
  );

  it("start closed: a function created in private later is not executable by PUBLIC", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`create function private.zz_probe_${randomUUID().slice(0, 8).replace(/-/g, "")}() returns int language sql as $$ select 1 $$`);
      const { rows } = await client.query(
        `select p.oid::regprocedure::text as fn from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname like 'zz_probe_%' and has_function_privilege('anon', p.oid, 'execute')`,
      );
      expect(rows).toEqual([]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("still lets signed-in people write what their check constraints call", async () => {
    // company_profiles.keywords is checked by private.valid_keywords, evaluated with the caller's rights.
    const res = await owner.client
      .from("company_profiles")
      .upsert({ organisation_id: orgId, keywords: ["road maintenance"] }, { onConflict: "organisation_id" });
    expect(res.error).toBeNull();
  });
});

describe("rate limit counters", () => {
  it("are behind row level security, so only the functions that own them can read or write", async () => {
    const { rows } = await pool.query(`select relrowsecurity from pg_class where oid = 'private.rate_limits'::regclass`);
    expect(rows[0].relrowsecurity).toBe(true);
    const { rows: privileges } = await pool.query(
      `select has_table_privilege('anon', 'private.rate_limits', 'select') as anon, has_table_privilege('authenticated', 'private.rate_limits', 'select') as auth`,
    );
    expect(privileges[0]).toEqual({ anon: false, auth: false });
    // The limiter itself still works.
    expect((await owner.client.rpc("hit_rate_limit", { p_action: "hygiene.check", p_max: 5, p_window_seconds: 60 })).error).toBeNull();
  });
});
