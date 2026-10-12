import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import type { Pool } from "@/lib/db/pool";
import { addMember, admin, bootstrapOrg, createUser, env, testPool, type TestUser } from "./helpers";

let pool: Pool;

const TOKEN = /^tinv_[a-f0-9]{64}$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const uniqueEmail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@tenderos.test`;

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params);
  return rows[0].n;
}

interface Issued {
  invitation_id: string;
  token: string;
  expires_at: string;
}

function invite(user: TestUser, orgId: string, email: string, role: string) {
  return user.client.rpc("create_invitation", { p_org: orgId, p_email: email, p_role: role } as never);
}

async function issue(user: TestUser, orgId: string, email: string, role: string): Promise<Issued> {
  const res = await invite(user, orgId, email, role);
  expect(res.error, `invite ${email} as ${role}`).toBeNull();
  return (res.data as unknown as Issued[])[0];
}

function accept(user: TestUser, token: string) {
  return user.client.rpc("accept_invitation", { p_token: token } as never);
}

async function roleOf(orgId: string, userId: string): Promise<string | null> {
  const { rows } = await pool.query<{ role: string }>(`select role from public.organisation_members where organisation_id = $1 and user_id = $2`, [
    orgId,
    userId,
  ]);
  return rows[0]?.role ?? null;
}

/** A confirmed user with a chosen address, signed in. */
async function userWithEmail(email: string): Promise<TestUser> {
  const password = `Pw-${randomUUID()}`;
  const { data, error } = await admin().auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient<Database>(env().url, env().anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  return { id: data.user.id, email, client };
}

interface Team {
  orgId: string;
  owner: TestUser;
  admin: TestUser;
  operator: TestUser;
  viewer: TestUser;
}

async function team(label: string): Promise<Team> {
  const [owner, adminUser, operator, viewer] = await Promise.all(["owner", "admin", "operator", "viewer"].map((r) => createUser(`${label}-${r}`)));
  const orgId = await bootstrapOrg(owner);
  await addMember(orgId, adminUser.id, "admin", pool);
  await addMember(orgId, operator.id, "operator", pool);
  await addMember(orgId, viewer.id, "viewer", pool);
  return { orgId, owner, admin: adminUser, operator, viewer };
}

beforeAll(() => {
  pool = testPool();
});

afterAll(async () => {
  await pool.end();
});

describe("create_invitation", () => {
  it("returns the token once, stores only its hash, and expires in seven days", async () => {
    const t = await team("inv-create");
    const email = uniqueEmail("Mixed.Case");
    const issued = await issue(t.owner, t.orgId, `  ${email.toUpperCase()}  `, "viewer");
    expect(issued.token).toMatch(TOKEN);
    const { rows } = await pool.query(`select email, role, token_hash, invited_by, expires_at, created_at from public.organisation_invitations where id = $1`, [
      issued.invitation_id,
    ]);
    expect(rows[0]).toMatchObject({ email: email.toLowerCase(), role: "viewer", token_hash: sha256(issued.token), invited_by: t.owner.id });
    const days = (Date.parse(rows[0].expires_at) - Date.parse(rows[0].created_at)) / 86_400_000;
    expect(days).toBeCloseTo(7, 3);
    expect(Date.parse(issued.expires_at)).toBe(Date.parse(rows[0].expires_at));
    expect(await count(`select 1 from public.organisation_invitations where token_hash = $1`, [issued.token])).toBe(0);
  });

  it("is audited without the invited address", async () => {
    const t = await team("inv-audit");
    const email = uniqueEmail("audited");
    const issued = await issue(t.owner, t.orgId, email, "operator");
    const { rows } = await pool.query(
      `select actor_user_id, resource_id, metadata from public.audit_logs where organisation_id = $1 and action = 'invitation.created'`,
      [t.orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: t.owner.id, resource_id: issued.invitation_id, metadata: { role: "operator" } });
    expect(JSON.stringify(rows[0].metadata)).not.toContain(email);
  });

  it("keeps the token hash out of every browser's reach", async () => {
    const t = await team("inv-hash");
    await issue(t.owner, t.orgId, uniqueEmail("hidden"), "viewer");
    expect((await t.owner.client.from("organisation_invitations").select("token_hash")).error).not.toBeNull();
    const ok = await t.owner.client.from("organisation_invitations").select("id, email, role, expires_at, accepted_at, revoked_at");
    expect(ok.error).toBeNull();
    expect(ok.data).toHaveLength(1);
    const anon = createClient<Database>(env().url, env().anon, { auth: { persistSession: false } });
    expect((await anon.from("organisation_invitations").select("id")).data ?? []).toEqual([]);
  });

  it("shows pending invitations to owners and admins only, and never across organisations", async () => {
    const a = await team("inv-rls-a");
    const b = await team("inv-rls-b");
    await issue(a.owner, a.orgId, uniqueEmail("visible"), "viewer");
    for (const reader of [a.owner, a.admin]) expect((await reader.client.from("organisation_invitations").select("id")).data).toHaveLength(1);
    for (const reader of [a.operator, a.viewer, b.owner]) expect((await reader.client.from("organisation_invitations").select("id")).data).toEqual([]);
    for (const writer of [a.owner, a.admin]) {
      expect((await writer.client.from("organisation_invitations").update({ role: "owner" }).eq("organisation_id", a.orgId)).error).not.toBeNull();
      expect((await writer.client.from("organisation_invitations").delete().eq("organisation_id", a.orgId)).error).not.toBeNull();
      expect(
        (await writer.client.from("organisation_invitations").insert({ organisation_id: a.orgId, email: "x@y.test", role: "viewer" } as never)).error,
      ).not.toBeNull();
    }
  });

  it("lets owners invite admins, operators and viewers, and admins invite operators and viewers", async () => {
    const t = await team("inv-roles");
    for (const role of ["admin", "operator", "viewer"]) await issue(t.owner, t.orgId, uniqueEmail(`o-${role}`), role);
    for (const role of ["operator", "viewer"]) await issue(t.admin, t.orgId, uniqueEmail(`a-${role}`), role);
    const refused = await invite(t.admin, t.orgId, uniqueEmail("a-admin"), "admin");
    expect(refused.error?.message).toMatch(/only an owner can invite an admin/i);
  });

  it("never invites an owner: ownership goes to someone already in the organisation", async () => {
    const t = await team("inv-noowner");
    expect((await invite(t.owner, t.orgId, uniqueEmail("boss"), "owner")).error).not.toBeNull();
    await expect(
      pool.query(`insert into public.organisation_invitations (organisation_id, email, role, token_hash) values ($1, $2, 'owner', $3)`, [
        t.orgId,
        uniqueEmail("boss"),
        sha256(randomUUID()),
      ]),
    ).rejects.toThrow();
  });

  it("refuses operators, viewers and outsiders", async () => {
    const t = await team("inv-no");
    const outsider = await createUser("inv-outsider");
    for (const caller of [t.operator, t.viewer, outsider]) {
      expect((await invite(caller, t.orgId, uniqueEmail("nope"), "viewer")).error).not.toBeNull();
    }
    expect(await count(`select 1 from public.organisation_invitations where organisation_id = $1`, [t.orgId])).toBe(0);
  });

  it("rejects an address that is not one", async () => {
    const t = await team("inv-bad");
    for (const bad of ["", "not-an-email", "a@b", "two@@tenderos.test", `${"x".repeat(250)}@tenderos.test`]) {
      expect((await invite(t.owner, t.orgId, bad, "viewer")).error, bad).not.toBeNull();
    }
  });

  it("refuses a second pending invitation to the same address, in any letter case", async () => {
    const t = await team("inv-dup");
    const email = uniqueEmail("dup");
    await issue(t.owner, t.orgId, email, "viewer");
    const again = await invite(t.owner, t.orgId, email.toUpperCase(), "operator");
    expect(again.error?.message).toMatch(/already.*pending invitation/i);
    expect(await count(`select 1 from public.organisation_invitations where organisation_id = $1`, [t.orgId])).toBe(1);
  });

  it("lets an invitation be issued again once the earlier one expired, was revoked or was used", async () => {
    const t = await team("inv-again");
    const email = uniqueEmail("again");
    const first = await issue(t.owner, t.orgId, email, "viewer");
    await pool.query(
      `update public.organisation_invitations set expires_at = now() - interval '1 minute', created_at = now() - interval '8 days' where id = $1`,
      [first.invitation_id],
    );
    const second = await issue(t.owner, t.orgId, email, "viewer");
    expect(second.invitation_id).not.toBe(first.invitation_id);
    expect((await t.owner.client.rpc("revoke_invitation", { p_id: second.invitation_id } as never)).error).toBeNull();
    await issue(t.owner, t.orgId, email, "operator");
  });

  it("does not tell whether an address has an account: the same answer either way", async () => {
    const t = await team("inv-enum");
    const existing = await createUser("inv-enum-existing");
    const asExisting = await invite(t.owner, t.orgId, existing.email, "viewer");
    const asNew = await invite(t.owner, t.orgId, uniqueEmail("never-seen"), "viewer");
    expect(asExisting.error).toBeNull();
    expect(asNew.error).toBeNull();
    const shape = (r: { data: unknown }) => Object.keys((r.data as Array<Record<string, unknown>>)[0]).sort();
    expect(shape(asExisting)).toEqual(shape(asNew));
  });

  it("refuses to invite someone who is already a member, which owners and admins can see anyway", async () => {
    const t = await team("inv-member");
    const res = await invite(t.owner, t.orgId, t.viewer.email, "viewer");
    expect(res.error?.message).toMatch(/already a member/i);
  });

  it("limits each person to 20 invitations an hour", async () => {
    const t = await team("inv-limit");
    for (let i = 0; i < 20; i++) await issue(t.owner, t.orgId, uniqueEmail(`l${i}`), "viewer");
    const over = await invite(t.owner, t.orgId, uniqueEmail("l-over"), "viewer");
    expect(over.error?.message).toMatch(/too many requests/i);
  });

  it("caps pending invitations per organisation at 50", async () => {
    const t = await team("inv-cap");
    for (let i = 0; i < 50; i++) {
      await pool.query(`insert into public.organisation_invitations (organisation_id, email, role, token_hash, invited_by) values ($1, $2, 'viewer', $3, $4)`, [
        t.orgId,
        uniqueEmail(`c${i}`),
        sha256(randomUUID()),
        t.owner.id,
      ]);
    }
    const over = await invite(t.owner, t.orgId, uniqueEmail("c-over"), "viewer");
    expect(over.error?.message).toMatch(/50 pending/i);
  });

  it("stops one address being flooded with invitations from anywhere: five a day", async () => {
    const t = await team("inv-flood");
    const email = uniqueEmail("victim");
    for (let i = 0; i < 5; i++) {
      const issued = await issue(t.owner, t.orgId, email, "viewer");
      expect((await t.owner.client.rpc("revoke_invitation", { p_id: issued.invitation_id } as never)).error).toBeNull();
    }
    const other = await team("inv-flood2");
    const sixth = await invite(other.owner, other.orgId, email, "viewer");
    expect(sixth.error?.message).toMatch(/too many/i);
  });
});

describe("revoke_invitation and resend_invitation", () => {
  it("revokes a pending invitation, which can then no longer be accepted", async () => {
    const t = await team("inv-revoke");
    const invitee = await userWithEmail(uniqueEmail("revoked"));
    const issued = await issue(t.admin, t.orgId, invitee.email, "viewer");
    expect((await t.admin.client.rpc("revoke_invitation", { p_id: issued.invitation_id } as never)).error).toBeNull();
    expect(await count(`select 1 from public.organisation_invitations where id = $1 and revoked_at is not null`, [issued.invitation_id])).toBe(1);
    expect((await accept(invitee, issued.token)).error?.message).toMatch(/no longer valid|not valid/i);
    expect(await roleOf(t.orgId, invitee.id)).toBeNull();
    expect(await count(`select 1 from public.audit_logs where organisation_id = $1 and action = 'invitation.revoked'`, [t.orgId])).toBe(1);
  });

  it("keeps admin invitations with owners", async () => {
    const t = await team("inv-revoke-admin");
    const issued = await issue(t.owner, t.orgId, uniqueEmail("adm"), "admin");
    expect((await t.admin.client.rpc("revoke_invitation", { p_id: issued.invitation_id } as never)).error).not.toBeNull();
    expect((await t.admin.client.rpc("resend_invitation", { p_id: issued.invitation_id } as never)).error).not.toBeNull();
    expect((await t.owner.client.rpc("revoke_invitation", { p_id: issued.invitation_id } as never)).error).toBeNull();
  });

  it("refuses operators, viewers, outsiders, and other organisations' owners", async () => {
    const t = await team("inv-revoke-no");
    const other = await team("inv-revoke-other");
    const issued = await issue(t.owner, t.orgId, uniqueEmail("keep"), "viewer");
    for (const caller of [t.operator, t.viewer, other.owner]) {
      expect((await caller.client.rpc("revoke_invitation", { p_id: issued.invitation_id } as never)).error).not.toBeNull();
      expect((await caller.client.rpc("resend_invitation", { p_id: issued.invitation_id } as never)).error).not.toBeNull();
    }
    expect(await count(`select 1 from public.organisation_invitations where id = $1 and revoked_at is null`, [issued.invitation_id])).toBe(1);
  });

  it("will not revoke or resend one that was accepted or revoked already", async () => {
    const t = await team("inv-final");
    const invitee = await userWithEmail(uniqueEmail("final"));
    const issued = await issue(t.owner, t.orgId, invitee.email, "viewer");
    expect((await accept(invitee, issued.token)).error).toBeNull();
    expect((await t.owner.client.rpc("revoke_invitation", { p_id: issued.invitation_id } as never)).error).not.toBeNull();
    expect((await t.owner.client.rpc("resend_invitation", { p_id: issued.invitation_id } as never)).error).not.toBeNull();
  });

  it("resends with a new token and a fresh week; the old token stops working", async () => {
    const t = await team("inv-resend");
    const invitee = await userWithEmail(uniqueEmail("resent"));
    const first = await issue(t.owner, t.orgId, invitee.email, "operator");
    await pool.query(`update public.organisation_invitations set expires_at = now() + interval '1 hour' where id = $1`, [first.invitation_id]);
    const res = await t.owner.client.rpc("resend_invitation", { p_id: first.invitation_id } as never);
    expect(res.error).toBeNull();
    const second = (res.data as unknown as Issued[])[0];
    expect(second.invitation_id).toBe(first.invitation_id);
    expect(second.token).toMatch(TOKEN);
    expect(second.token).not.toBe(first.token);
    expect((Date.parse(second.expires_at) - Date.now()) / 86_400_000).toBeGreaterThan(6.9);
    expect((await accept(invitee, first.token)).error).not.toBeNull();
    expect((await accept(invitee, second.token)).error).toBeNull();
    expect(await roleOf(t.orgId, invitee.id)).toBe("operator");
  });

  it("brings an expired invitation back to life on resend", async () => {
    const t = await team("inv-revive");
    const invitee = await userWithEmail(uniqueEmail("revived"));
    const first = await issue(t.owner, t.orgId, invitee.email, "viewer");
    await pool.query(
      `update public.organisation_invitations set expires_at = now() - interval '1 minute', created_at = now() - interval '8 days' where id = $1`,
      [first.invitation_id],
    );
    expect((await accept(invitee, first.token)).error?.message).toMatch(/expired/i);
    const res = await t.owner.client.rpc("resend_invitation", { p_id: first.invitation_id } as never);
    expect(res.error).toBeNull();
    expect((await accept(invitee, (res.data as unknown as Issued[])[0].token)).error).toBeNull();
  });
});

describe("accept_invitation", () => {
  it("makes the invited person a member with the invited role, and audits it", async () => {
    const t = await team("acc-ok");
    const invitee = await userWithEmail(uniqueEmail("joiner"));
    const issued = await issue(t.owner, t.orgId, invitee.email, "viewer");
    const res = await accept(invitee, issued.token);
    expect(res.error).toBeNull();
    expect(res.data).toBe(t.orgId);
    expect(await roleOf(t.orgId, invitee.id)).toBe("viewer");
    const { rows } = await pool.query(`select accepted_at, accepted_by from public.organisation_invitations where id = $1`, [issued.invitation_id]);
    expect(rows[0].accepted_by).toBe(invitee.id);
    expect(rows[0].accepted_at).not.toBeNull();
    const audit = await pool.query(`select actor_user_id, metadata from public.audit_logs where organisation_id = $1 and action = 'invitation.accepted'`, [
      t.orgId,
    ]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_user_id: invitee.id, metadata: { role: "viewer" } });
    // The new member sees the organisation (RLS follows membership).
    const { data: orgs } = await invitee.client.from("organisations").select("id");
    expect(orgs).toEqual([{ id: t.orgId }]);
    // And, as a viewer, can change nothing.
    expect((await invitee.client.rpc("set_kill_switch", { p_org: t.orgId, p_engaged: true, p_reason: "viewer trying" })).error).not.toBeNull();
  });

  it("works for an address that signed up after the invitation was sent", async () => {
    const t = await team("acc-later");
    const email = uniqueEmail("later");
    const issued = await issue(t.owner, t.orgId, email, "operator");
    const invitee = await userWithEmail(email);
    expect((await accept(invitee, issued.token)).error).toBeNull();
    expect(await roleOf(t.orgId, invitee.id)).toBe("operator");
  });

  it("is for the invited address only", async () => {
    const t = await team("acc-wrong");
    const invitee = await userWithEmail(uniqueEmail("right"));
    const stranger = await userWithEmail(uniqueEmail("wrong"));
    const issued = await issue(t.owner, t.orgId, invitee.email, "viewer");
    const res = await accept(stranger, issued.token);
    expect(res.error?.message).toMatch(/different email address/i);
    expect(res.error?.message).not.toContain(invitee.email);
    expect(await roleOf(t.orgId, stranger.id)).toBeNull();
    expect(await count(`select 1 from public.organisation_invitations where id = $1 and accepted_at is null`, [issued.invitation_id])).toBe(1);
    // The right person can still use it.
    expect((await accept(invitee, issued.token)).error).toBeNull();
  });

  it("needs a confirmed address, not just a matching one", async () => {
    const t = await team("acc-unconfirmed");
    const invitee = await userWithEmail(uniqueEmail("unconfirmed"));
    const issued = await issue(t.owner, t.orgId, invitee.email, "viewer");
    await pool.query(`update auth.users set email_confirmed_at = null where id = $1`, [invitee.id]);
    const res = await accept(invitee, issued.token);
    expect(res.error?.message).toMatch(/confirm/i);
    expect(await roleOf(t.orgId, invitee.id)).toBeNull();
  });

  it("refuses an address changed since the session began", async () => {
    const t = await team("acc-changed");
    const invitee = await userWithEmail(uniqueEmail("old-address"));
    const issued = await issue(t.owner, t.orgId, invitee.email, "viewer");
    await pool.query(`update auth.users set email = $2 where id = $1`, [invitee.id, uniqueEmail("new-address")]);
    expect((await accept(invitee, issued.token)).error).not.toBeNull();
    expect(await roleOf(t.orgId, invitee.id)).toBeNull();
  });

  it("turns away unknown, malformed and used tokens with one plain message", async () => {
    const t = await team("acc-bad");
    const invitee = await userWithEmail(uniqueEmail("bad"));
    const issued = await issue(t.owner, t.orgId, invitee.email, "viewer");
    const thief = await userWithEmail(uniqueEmail("thief"));
    expect((await accept(invitee, issued.token)).error).toBeNull();
    const messages = new Set<string>();
    for (const token of [`tinv_${"0".repeat(64)}`, "tinv_short", "", "x".repeat(300), issued.token]) {
      const res = await accept(thief, token);
      expect(res.error, token.slice(0, 12)).not.toBeNull();
      messages.add(res.error!.message);
    }
    expect([...messages]).toHaveLength(1);
    expect(await roleOf(t.orgId, thief.id)).toBeNull();
  });

  it("is safe to repeat for the person who already joined", async () => {
    const t = await team("acc-repeat");
    const invitee = await userWithEmail(uniqueEmail("repeat"));
    const issued = await issue(t.owner, t.orgId, invitee.email, "operator");
    expect((await accept(invitee, issued.token)).error).toBeNull();
    const again = await accept(invitee, issued.token);
    expect(again.error).toBeNull();
    expect(again.data).toBe(t.orgId);
    expect(await count(`select 1 from public.audit_logs where organisation_id = $1 and action = 'invitation.accepted'`, [t.orgId])).toBe(1);
  });

  it("explains it when the person already belongs to another organisation, and works after they leave it", async () => {
    const t = await team("acc-other");
    const other = await team("acc-other-home");
    const invitee = await userWithEmail(uniqueEmail("busy"));
    await addMember(other.orgId, invitee.id, "operator", pool);
    const issued = await issue(t.owner, t.orgId, invitee.email, "viewer");
    const refused = await accept(invitee, issued.token);
    expect(refused.error?.message).toMatch(/already belong to another organisation.*leave/i);
    expect(await roleOf(t.orgId, invitee.id)).toBeNull();
    expect(await roleOf(other.orgId, invitee.id)).toBe("operator");
    expect(await count(`select 1 from public.organisation_invitations where id = $1 and accepted_at is null`, [issued.invitation_id])).toBe(1);

    expect((await invitee.client.rpc("remove_member", { p_org: other.orgId, p_user: invitee.id } as never)).error).toBeNull();
    expect((await accept(invitee, issued.token)).error).toBeNull();
    expect(await roleOf(t.orgId, invitee.id)).toBe("viewer");
  });

  it("lets only one of two simultaneous invitations win", async () => {
    const a = await team("acc-race-a");
    const b = await team("acc-race-b");
    const invitee = await userWithEmail(uniqueEmail("racer"));
    const [one, two] = await Promise.all([issue(a.owner, a.orgId, invitee.email, "viewer"), issue(b.owner, b.orgId, invitee.email, "viewer")]);
    const results = await Promise.all([accept(invitee, one.token), accept(invitee, two.token)]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(await count(`select 1 from public.organisation_members where user_id = $1`, [invitee.id])).toBe(1);
  });

  it("is limited to ten calls an hour per person", async () => {
    // A call that raises rolls its counter back with everything else, so only calls that succeed are counted here;
    // the server action counts every attempt first (tests/unit/invitation-actions.test.ts). Tokens carry 256 bits,
    // so guessing one is not a practical attack either way.
    const t = await team("acc-limit");
    const invitee = await userWithEmail(uniqueEmail("hammer"));
    const issued = await issue(t.owner, t.orgId, invitee.email, "viewer");
    const outcomes: string[] = [];
    for (let i = 0; i < 11; i++) outcomes.push((await accept(invitee, issued.token)).error?.message ?? "ok");
    expect(outcomes.slice(0, 10).every((o) => o === "ok")).toBe(true);
    expect(outcomes[10]).toMatch(/too many requests/i);
  });

  it("cannot be called without signing in", async () => {
    const anon = createClient<Database>(env().url, env().anon, { auth: { persistSession: false } });
    expect((await anon.rpc("accept_invitation", { p_token: `tinv_${"b".repeat(64)}` } as never)).error).not.toBeNull();
    expect((await anon.rpc("create_invitation", { p_org: randomUUID(), p_email: "x@y.test", p_role: "viewer" } as never)).error).not.toBeNull();
  });
});

describe("invitation_preview (server only)", () => {
  it("tells the server which organisation, role and address a live token is for", async () => {
    const t = await team("pre-ok");
    const email = uniqueEmail("preview");
    const issued = await issue(t.owner, t.orgId, email, "viewer");
    const { data, error } = await admin().rpc("invitation_preview", { p_token: issued.token } as never);
    expect(error).toBeNull();
    const rows = data as unknown as Array<{ organisation_id: string; organisation_name: string; role: string; email: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organisation_id: t.orgId, role: "viewer", email });
    expect(rows[0].organisation_name).toBeTruthy();
  });

  it("says nothing about a token that is expired, revoked, used or unknown", async () => {
    const t = await team("pre-dead");
    const invitee = await userWithEmail(uniqueEmail("pre-dead"));
    const expired = await issue(t.owner, t.orgId, uniqueEmail("pre-expired"), "viewer");
    await pool.query(
      `update public.organisation_invitations set expires_at = now() - interval '1 minute', created_at = now() - interval '8 days' where id = $1`,
      [expired.invitation_id],
    );
    const revoked = await issue(t.owner, t.orgId, uniqueEmail("pre-revoked"), "viewer");
    await t.owner.client.rpc("revoke_invitation", { p_id: revoked.invitation_id } as never);
    const used = await issue(t.owner, t.orgId, invitee.email, "viewer");
    await accept(invitee, used.token);
    for (const token of [expired.token, revoked.token, used.token, `tinv_${"c".repeat(64)}`, "garbage"]) {
      const { data, error } = await admin().rpc("invitation_preview", { p_token: token } as never);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
  });

  it("is closed to browsers and the anonymous", async () => {
    const t = await team("pre-closed");
    const issued = await issue(t.owner, t.orgId, uniqueEmail("pre-closed"), "viewer");
    expect((await t.owner.client.rpc("invitation_preview", { p_token: issued.token } as never)).error).not.toBeNull();
    const anon = createClient<Database>(env().url, env().anon, { auth: { persistSession: false } });
    expect((await anon.rpc("invitation_preview", { p_token: issued.token } as never)).error).not.toBeNull();
  });
});

describe("personal data in invitations (POPIA)", () => {
  it("removes invitations addressed to a person when their account is deleted", async () => {
    const t = await team("pii-user");
    const invitee = await userWithEmail(uniqueEmail("pii"));
    const issued = await issue(t.owner, t.orgId, invitee.email, "viewer");
    expect((await accept(invitee, issued.token)).error).toBeNull();
    await issue(t.owner, t.orgId, uniqueEmail("someone-else"), "viewer");
    expect((await admin().auth.admin.deleteUser(invitee.id)).error).toBeNull();
    expect(await count(`select 1 from public.organisation_invitations where lower(email) = lower($1)`, [invitee.email])).toBe(0);
    expect(await count(`select 1 from public.organisation_invitations where organisation_id = $1`, [t.orgId])).toBe(1);
  });

  it("keeps an invitation after whoever sent it is erased, without their id", async () => {
    const t = await team("pii-inviter");
    const issued = await issue(t.admin, t.orgId, uniqueEmail("kept"), "viewer");
    expect((await admin().auth.admin.deleteUser(t.admin.id)).error).toBeNull();
    const { rows } = await pool.query(`select invited_by from public.organisation_invitations where id = $1`, [issued.invitation_id]);
    expect(rows).toEqual([{ invited_by: null }]);
  });

  it("purges invitations that ended more than 30 days ago, and only those", async () => {
    const t = await team("pii-purge");
    const old = await issue(t.owner, t.orgId, uniqueEmail("old"), "viewer");
    const oldRevoked = await issue(t.owner, t.orgId, uniqueEmail("old-revoked"), "viewer");
    const fresh = await issue(t.owner, t.orgId, uniqueEmail("fresh"), "viewer");
    await pool.query(
      `update public.organisation_invitations set created_at = now() - interval '45 days', expires_at = now() - interval '38 days' where id = $1`,
      [old.invitation_id],
    );
    await pool.query(`update public.organisation_invitations set revoked_at = now() - interval '31 days' where id = $1`, [oldRevoked.invitation_id]);
    const { rows } = await pool.query(`select private.purge_invitations() as n`);
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
    expect(await count(`select 1 from public.organisation_invitations where id = any($1)`, [[old.invitation_id, oldRevoked.invitation_id]])).toBe(0);
    expect(await count(`select 1 from public.organisation_invitations where id = $1`, [fresh.invitation_id])).toBe(1);
  });

  it("is part of the organisation's export (without the token hash) and of the person's own export", async () => {
    const t = await team("pii-export");
    const invitee = await userWithEmail(uniqueEmail("exported"));
    const pending = await issue(t.owner, t.orgId, uniqueEmail("pending-export"), "viewer");
    const used = await issue(t.owner, t.orgId, invitee.email, "viewer");
    expect((await accept(invitee, used.token)).error).toBeNull();

    const org = await admin().rpc("export_organisation_data", { p_org: t.orgId } as never);
    expect(org.error).toBeNull();
    const orgExport = org.data as unknown as { invitations: Array<Record<string, unknown>> };
    expect(orgExport.invitations).toHaveLength(2);
    expect(JSON.stringify(orgExport)).not.toContain(sha256(pending.token));
    expect(JSON.stringify(orgExport)).not.toContain("token_hash");

    const person = await admin().rpc("export_user_data", { p_user_id: invitee.id } as never);
    expect(person.error).toBeNull();
    const personExport = person.data as unknown as { invitations_received: Array<{ organisation_name: string; role: string }>; invitations_sent: number };
    expect(personExport.invitations_received).toHaveLength(1);
    expect(personExport.invitations_received[0].role).toBe("viewer");
    expect(JSON.stringify(personExport)).not.toContain("token_hash");
    const owner = await admin().rpc("export_user_data", { p_user_id: t.owner.id } as never);
    expect((owner.data as unknown as { invitations_sent: number }).invitations_sent).toBe(2);
  });
});
