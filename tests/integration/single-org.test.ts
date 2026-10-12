import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registryPayload } from "@/lib/org/bootstrap";
import type { Pool } from "@/lib/db/pool";
import { addMember, admin, bootstrapOrg, createUser, testPool } from "./helpers";

let pool: Pool;

beforeAll(() => {
  pool = testPool();
});

afterAll(async () => {
  await pool.end();
});

const bootstrap = (userId: string, name: string) =>
  admin().rpc("bootstrap_organisation", {
    p_user_id: userId,
    p_name: name,
    p_slug: `race-${randomUUID().slice(0, 12)}`,
    ...registryPayload(),
  } as never);

describe("one organisation per user", () => {
  it("is enforced by a unique index on membership", async () => {
    const user = await createUser("single-a");
    const first = await bootstrapOrg(user);
    const other = await createUser("single-other");
    const second = await bootstrapOrg(other, `Second ${randomUUID().slice(0, 6)}`);
    await expect(addMember(second, user.id, "viewer", pool)).rejects.toMatchObject({ code: "23505" });
    const { rows } = await pool.query(`select organisation_id from public.organisation_members where user_id = $1`, [user.id]);
    expect(rows).toEqual([{ organisation_id: first }]);
  });

  it("refuses a second bootstrap for the same user with the message the form shows", async () => {
    const user = await createUser("single-b");
    await bootstrapOrg(user);
    const { error } = await bootstrap(user.id, `Again ${randomUUID().slice(0, 6)}`);
    expect(error?.code).toBe("23505");
    expect(error?.message).toBe("User already belongs to an organisation");
  });

  it("lets only one of two simultaneous sign-ups create an organisation, leaving nothing behind", async () => {
    const user = await createUser("single-race");
    const tag = randomUUID().slice(0, 8);
    const results = await Promise.all([bootstrap(user.id, `Race ${tag} one`), bootstrap(user.id, `Race ${tag} two`), bootstrap(user.id, `Race ${tag} three`)]);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    for (const r of results.filter((x) => x.error)) expect(r.error?.code).toBe("23505");

    const members = await pool.query(`select organisation_id from public.organisation_members where user_id = $1`, [user.id]);
    expect(members.rows).toHaveLength(1);
    // The refused calls rolled back whole: no stray organisation, settings or agents.
    const orgs = await pool.query(`select id from public.organisations where name like $1`, [`Race ${tag}%`]);
    expect(orgs.rows).toHaveLength(1);
    expect(orgs.rows[0].id).toBe(members.rows[0].organisation_id);
    const agents = await pool.query(`select count(*)::int as n from public.agents where organisation_id = $1`, [orgs.rows[0].id]);
    expect(agents.rows[0].n).toBeGreaterThan(0);
  });

  it("keeps the signature, privileges and advisory lock of bootstrap_organisation", async () => {
    const { rows } = await pool.query(
      `select pg_get_functiondef(p.oid) as def,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              has_function_privilege('service_role', p.oid, 'execute') as service_role
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'bootstrap_organisation'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toContain("pg_advisory_xact_lock(hashtextextended('tenderos.bootstrap:'");
    expect(rows[0]).toMatchObject({ anon: false, authenticated: false, service_role: true });
  });

  it("drops the index the unique one replaces", async () => {
    const { rows } = await pool.query(`select indexname from pg_indexes where schemaname = 'public' and tablename = 'organisation_members' order by indexname`);
    const names = rows.map((r) => r.indexname);
    expect(names).toContain("organisation_members_user_uq");
    expect(names).not.toContain("organisation_members_user_idx");
  });
});

describe("the migration's pre-check", () => {
  it("refuses to run while any user belongs to more than one organisation", async () => {
    const file = readdirSync("supabase/migrations").find((f) => f.endsWith("_single_org_membership.sql"));
    const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
    const check = sql.match(/do \$\$[\s\S]*?\$\$;/i)?.[0];
    expect(check, "a DO block that checks for users with several memberships").toBeTruthy();

    const a = await createUser("single-pre-a");
    const orgA = await bootstrapOrg(a);
    const b = await createUser("single-pre-b");
    const orgB = await bootstrapOrg(b);
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Recreate the state the migration must refuse: the same user in two organisations.
      await client.query(`drop index public.organisation_members_user_uq`);
      await client.query(`insert into public.organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')`, [orgB, a.id]);
      await expect(client.query(check!)).rejects.toThrow(/more than one organisation/i);
      await client.query("rollback");
      await client.query("begin");
      // Without the duplicate the same block passes.
      await client.query(check!);
    } finally {
      await client.query("rollback");
      client.release();
    }
    expect(orgA).not.toBe(orgB);
    const { rows } = await pool.query(`select count(*)::int as n from public.organisation_members where user_id = $1`, [a.id]);
    expect(rows[0].n).toBe(1);
  });
});
