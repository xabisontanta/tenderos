import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import type { Pool } from "@/lib/db/pool";
import { addMember, admin, bootstrapOrg, createUser, env, testPool, type TestUser } from "./helpers";

let pool: Pool;

beforeAll(() => {
  pool = testPool();
});

afterAll(async () => {
  await pool.end();
});

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params);
  return rows[0].n;
}

/** A verified authenticator for the user, as Supabase Auth would have stored it. */
async function giveAuthenticator(user: TestUser, name = "Phone"): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
     values ($1, $2, $3, 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP')`,
    [id, user.id, name],
  );
  return id;
}

describe("reset_user_mfa (the lost-device runbook, docs/auth.md)", () => {
  it("removes every authenticator, ends every session, and audits it with the ticket reference", async () => {
    const owner = await createUser("reset-owner");
    const orgId = await bootstrapOrg(owner);
    const member = await createUser("reset-member");
    await addMember(orgId, member.id, "operator", pool);
    await giveAuthenticator(member, "Old phone");
    await giveAuthenticator(member, "Tablet");
    expect(await count(`select 1 from auth.sessions where user_id = $1`, [member.id])).toBeGreaterThan(0);

    const res = await admin().rpc("reset_user_mfa", { p_user_id: member.id, p_reference: "REQ-2026-021" } as never);
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ factors_removed: 2 });
    expect((res.data as unknown as { sessions_ended: number }).sessions_ended).toBeGreaterThan(0);

    expect(await count(`select 1 from auth.mfa_factors where user_id = $1`, [member.id])).toBe(0);
    expect(await count(`select 1 from auth.sessions where user_id = $1`, [member.id])).toBe(0);
    // The old session is dead: the person has to sign in again with their password.
    expect((await member.client.auth.getUser()).error).not.toBeNull();

    const { rows } = await pool.query(
      `select actor_type, organisation_id, resource_id, metadata from public.audit_logs where action = 'mfa.reset' and resource_id = $1`,
      [member.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "system", organisation_id: orgId, metadata: { reference: "REQ-2026-021", factors_removed: 2 } });
    // Their membership and the organisation are untouched.
    expect(await count(`select 1 from public.organisation_members where user_id = $1 and organisation_id = $2`, [member.id, orgId])).toBe(1);
  });

  it("leaves other people's authenticators and sessions alone", async () => {
    const a = await createUser("reset-a");
    const b = await createUser("reset-b");
    await giveAuthenticator(a);
    await giveAuthenticator(b);
    expect((await admin().rpc("reset_user_mfa", { p_user_id: a.id, p_reference: "REQ-1" } as never)).error).toBeNull();
    expect(await count(`select 1 from auth.mfa_factors where user_id = $1`, [b.id])).toBe(1);
    expect((await b.client.auth.getUser()).error).toBeNull();
  });

  it("works for someone with no organisation and no authenticator, and says so", async () => {
    const lone = await createUser("reset-lone");
    const res = await admin().rpc("reset_user_mfa", { p_user_id: lone.id, p_reference: "REQ-2" } as never);
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ factors_removed: 0 });
  });

  it("is for the service role only", async () => {
    const user = await createUser("reset-browser");
    expect((await user.client.rpc("reset_user_mfa", { p_user_id: user.id, p_reference: "REQ-3" } as never)).error).not.toBeNull();
    const anon = createClient<Database>(env().url, env().anon, { auth: { persistSession: false } });
    expect((await anon.rpc("reset_user_mfa", { p_user_id: user.id, p_reference: "REQ-3" } as never)).error).not.toBeNull();
  });

  it("needs a reference without names or addresses in it, and a user that exists", async () => {
    const user = await createUser("reset-ref");
    for (const bad of [null, "", "Thandi Nkosi", "thandi@example.test", "x".repeat(65)]) {
      expect((await admin().rpc("reset_user_mfa", { p_user_id: user.id, p_reference: bad } as never)).error, String(bad)).not.toBeNull();
    }
    const ghost = await admin().rpc("reset_user_mfa", { p_user_id: randomUUID(), p_reference: "REQ-4" } as never);
    expect(ghost.error?.message).toMatch(/not found/i);
  });

  it("is limited to three resets an hour for one person", async () => {
    const user = await createUser("reset-limit");
    for (let i = 0; i < 3; i++) expect((await admin().rpc("reset_user_mfa", { p_user_id: user.id, p_reference: `REQ-5-${i}` } as never)).error).toBeNull();
    const over = await admin().rpc("reset_user_mfa", { p_user_id: user.id, p_reference: "REQ-5-over" } as never);
    expect(over.error?.message).toMatch(/too many requests/i);
  });
});
