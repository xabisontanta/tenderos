import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";
import type { Pool } from "@/lib/db/pool";
import type { Database } from "@/types/database";
import { admin, createUser, env, testPool, type TestUser } from "./helpers";

let pool: Pool;

beforeAll(() => {
  pool = testPool();
});

afterAll(async () => {
  await pool.end();
});

const hex = () => randomUUID().replaceAll("-", "").repeat(2);

/** Creates a confirmed user the way sign-up does: with the consent metadata the form sends. */
async function signUpWith(metadata: Record<string, unknown>) {
  const email = `legal-${randomUUID().slice(0, 8)}@tenderos.test`;
  const { data, error } = await admin().auth.admin.createUser({ email, password: `Pw-${randomUUID()}`, email_confirm: true, user_metadata: metadata });
  if (error) throw error;
  return data.user.id;
}

const acceptances = async (userId: string) =>
  (await pool.query(`select kind, version, ip_hmac from public.legal_acceptances where user_id = $1 order by kind`, [userId])).rows;

describe("legal documents", () => {
  it("name the versions the app asks visitors to accept as current", async () => {
    const { rows } = await pool.query(`select kind, version from public.legal_documents where is_current order by kind`);
    expect(rows).toEqual([
      { kind: "privacy", version: LEGAL_VERSIONS.privacy },
      { kind: "terms", version: LEGAL_VERSIONS.terms },
    ]);
  });

  it("can be read by anyone and changed by no one", async () => {
    const anon = createClient<Database>(env().url, env().anon, { auth: { persistSession: false } });
    const read = await anon.from("legal_documents").select("kind, version, is_current");
    expect(read.error).toBeNull();
    expect(read.data!.length).toBeGreaterThanOrEqual(2);
    expect((await anon.from("legal_documents").insert({ kind: "terms", version: "x-1" } as never)).error).not.toBeNull();

    const user = await createUser("legal-writer");
    expect((await user.client.from("legal_documents").insert({ kind: "terms", version: "x-2" } as never)).error).not.toBeNull();
    const flip = await user.client.from("legal_documents").update({ is_current: false }).eq("kind", "terms").select();
    expect(flip.data ?? []).toEqual([]);
    const { rows } = await pool.query(`select count(*)::int as n from public.legal_documents where is_current`);
    expect(rows[0].n).toBe(2);
  });

  it("allow only one current version per kind", async () => {
    await expect(pool.query(`insert into public.legal_documents (kind, version, is_current) values ('terms', 'dup-current', true)`)).rejects.toMatchObject({
      code: "23505",
    });
  });
});

describe("consent recorded at sign-up", () => {
  it("is stored with the versions and the origin hash when the sign-up carried the current versions", async () => {
    const ip = hex();
    const id = await signUpWith({
      full_name: "Consent Tester",
      terms_version: LEGAL_VERSIONS.terms,
      privacy_version: LEGAL_VERSIONS.privacy,
      consent_ip_hmac: ip,
    });
    expect(await acceptances(id)).toEqual([
      { kind: "privacy", version: LEGAL_VERSIONS.privacy, ip_hmac: ip },
      { kind: "terms", version: LEGAL_VERSIONS.terms, ip_hmac: ip },
    ]);
    const profile = await pool.query(`select full_name from public.profiles where id = $1`, [id]);
    expect(profile.rows[0].full_name).toBe("Consent Tester");
  });

  it("is not stored for an old, unknown or partial claim, and the sign-up still succeeds", async () => {
    const cases: Array<Record<string, unknown>> = [
      { terms_version: "2020-01-01-old", privacy_version: LEGAL_VERSIONS.privacy },
      { terms_version: LEGAL_VERSIONS.terms },
      { terms_version: "nonsense", privacy_version: "nonsense" },
      { terms_version: 7, privacy_version: { a: 1 } },
      { terms_version: [LEGAL_VERSIONS.terms], privacy_version: [LEGAL_VERSIONS.privacy] },
      {},
    ];
    for (const metadata of cases) {
      const id = await signUpWith({ full_name: "No Consent", ...metadata });
      expect(await acceptances(id), JSON.stringify(metadata)).toEqual([]);
      expect((await pool.query(`select 1 from public.profiles where id = $1`, [id])).rowCount).toBe(1);
    }
  });

  it("ignores an origin hash that is not a hash", async () => {
    const id = await signUpWith({ terms_version: LEGAL_VERSIONS.terms, privacy_version: LEGAL_VERSIONS.privacy, consent_ip_hmac: "41.0.0.9" });
    const rows = await acceptances(id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.ip_hmac === null)).toBe(true);
  });
});

describe("accepting the current documents later", () => {
  let user: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    user = await createUser("legal-user");
    other = await createUser("legal-other");
  });

  it("starts with both documents pending", async () => {
    const { data, error } = await user.client.rpc("pending_legal_acceptances");
    expect(error).toBeNull();
    expect(data).toEqual([
      { kind: "privacy", version: LEGAL_VERSIONS.privacy },
      { kind: "terms", version: LEGAL_VERSIONS.terms },
    ]);
  });

  it("records acceptance, once, and clears what was pending", async () => {
    const ip = hex();
    const args = { p_terms_version: LEGAL_VERSIONS.terms, p_privacy_version: LEGAL_VERSIONS.privacy, p_ip_hmac: ip };
    expect((await user.client.rpc("accept_legal", args)).error).toBeNull();
    expect((await user.client.rpc("accept_legal", args)).error).toBeNull();
    expect(await acceptances(user.id)).toHaveLength(2);
    const { data } = await user.client.rpc("pending_legal_acceptances");
    expect(data).toEqual([]);
    // Someone else still has both pending.
    expect(((await other.client.rpc("pending_legal_acceptances")).data ?? []).length).toBe(2);
  });

  it("refuses versions that are not the current ones", async () => {
    const stale = await other.client.rpc("accept_legal", { p_terms_version: "2020-01-01-old", p_privacy_version: LEGAL_VERSIONS.privacy });
    expect(stale.error?.code).toBe("23514");
    expect(stale.error?.message).toMatch(/updated/i);
    expect(await acceptances(other.id)).toEqual([]);
  });

  it("stores nothing for a malformed origin hash instead of failing", async () => {
    const third = await createUser("legal-third");
    const res = await third.client.rpc("accept_legal", {
      p_terms_version: LEGAL_VERSIONS.terms,
      p_privacy_version: LEGAL_VERSIONS.privacy,
      p_ip_hmac: "41.0.0.9",
    });
    expect(res.error).toBeNull();
    expect((await acceptances(third.id)).every((r) => r.ip_hmac === null)).toBe(true);
  });

  it("needs a signed-in user", async () => {
    const anon = createClient<Database>(env().url, env().anon, { auth: { persistSession: false } });
    const res = await anon.rpc("accept_legal", { p_terms_version: LEGAL_VERSIONS.terms, p_privacy_version: LEGAL_VERSIONS.privacy });
    expect(res.error).not.toBeNull();
  });

  it("is rate limited", async () => {
    const spammer = await createUser("legal-spam");
    const args = { p_terms_version: LEGAL_VERSIONS.terms, p_privacy_version: LEGAL_VERSIONS.privacy };
    let last;
    for (let i = 0; i < 11; i++) last = await spammer.client.rpc("accept_legal", args);
    expect(last!.error?.code).toBe("P0429");
  });

  it("asks again when a new version is published", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`update public.legal_documents set is_current = false where kind = 'terms'`);
      await client.query(`insert into public.legal_documents (kind, version, is_current) values ('terms', 'test-v2', true)`);
      await client.query(`set local role authenticated`);
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user.id, role: "authenticated" })]);
      const { rows } = await client.query(`select kind, version from public.pending_legal_acceptances()`);
      expect(rows).toEqual([{ kind: "terms", version: "test-v2" }]);
    } finally {
      await client.query("rollback");
      client.release();
    }
    const { data } = await user.client.rpc("pending_legal_acceptances");
    expect(data).toEqual([]);
  });
});

describe("consent records", () => {
  it("are visible to their owner only, and cannot be written by users", async () => {
    const a = await createUser("legal-a");
    const b = await createUser("legal-b");
    const args = { p_terms_version: LEGAL_VERSIONS.terms, p_privacy_version: LEGAL_VERSIONS.privacy };
    await a.client.rpc("accept_legal", args);
    await b.client.rpc("accept_legal", args);

    const own = await a.client.from("legal_acceptances").select("user_id");
    expect(own.error).toBeNull();
    expect(new Set(own.data!.map((r) => r.user_id))).toEqual(new Set([a.id]));

    expect((await a.client.from("legal_acceptances").insert({ user_id: a.id, kind: "terms", version: "x" } as never)).error).not.toBeNull();
    expect(
      (
        await a.client
          .from("legal_acceptances")
          .update({ version: "x" } as never)
          .eq("user_id", a.id)
      ).error,
    ).not.toBeNull();
    expect((await a.client.from("legal_acceptances").delete().eq("user_id", a.id)).error).not.toBeNull();
    expect(await acceptances(a.id)).toHaveLength(2);

    const anon = createClient<Database>(env().url, env().anon, { auth: { persistSession: false } });
    expect((await anon.from("legal_acceptances").select("*")).data ?? []).toEqual([]);
  });

  it("go when the account goes", async () => {
    const id = await signUpWith({ terms_version: LEGAL_VERSIONS.terms, privacy_version: LEGAL_VERSIONS.privacy });
    expect(await acceptances(id)).toHaveLength(2);
    expect((await admin().auth.admin.deleteUser(id)).error).toBeNull();
    expect(await acceptances(id)).toEqual([]);
  });
});
