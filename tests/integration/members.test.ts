import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import { addMember, admin, bootstrapOrg, createUser, testPool, type TestUser } from "./helpers";

let pool: Pool;

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params);
  return rows[0].n;
}

async function roleOf(orgId: string, userId: string): Promise<string | null> {
  const { rows } = await pool.query<{ role: string }>(`select role from public.organisation_members where organisation_id = $1 and user_id = $2`, [
    orgId,
    userId,
  ]);
  return rows[0]?.role ?? null;
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

function change(user: TestUser, orgId: string, target: string, role: string) {
  return user.client.rpc("change_member_role", { p_org: orgId, p_user: target, p_role: role } as never);
}

function remove(user: TestUser, orgId: string, target: string) {
  return user.client.rpc("remove_member", { p_org: orgId, p_user: target } as never);
}

beforeAll(() => {
  pool = testPool();
});

afterAll(async () => {
  await pool.end();
});

describe("list_members", () => {
  it("gives owners and admins names, roles and email addresses", async () => {
    const t = await team("list");
    await pool.query(`update public.profiles set full_name = 'Operator Olive' where id = $1`, [t.operator.id]);
    for (const reader of [t.owner, t.admin]) {
      const { data, error } = await reader.client.rpc("list_members", { p_org: t.orgId } as never);
      expect(error).toBeNull();
      const rows = data as unknown as Array<{ user_id: string; full_name: string | null; email: string | null; role: string; joined_at: string }>;
      expect(rows).toHaveLength(4);
      const olive = rows.find((r) => r.user_id === t.operator.id)!;
      expect(olive).toMatchObject({ full_name: "Operator Olive", email: t.operator.email, role: "operator" });
      expect(Date.parse(olive.joined_at)).not.toBeNaN();
    }
  });

  it("shows operators and viewers names and roles, never email addresses", async () => {
    const t = await team("listro");
    for (const reader of [t.operator, t.viewer]) {
      const { data, error } = await reader.client.rpc("list_members", { p_org: t.orgId } as never);
      expect(error).toBeNull();
      const rows = data as unknown as Array<{ email: string | null; role: string }>;
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.email === null)).toBe(true);
      expect(rows.map((r) => r.role).sort()).toEqual(["admin", "operator", "owner", "viewer"]);
    }
  });

  it("shows nothing to someone outside the organisation, and nothing to the anonymous", async () => {
    const t = await team("listout");
    const outsider = await createUser("list-outsider");
    const res = await outsider.client.rpc("list_members", { p_org: t.orgId } as never);
    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
  });
});

describe("change_member_role", () => {
  it("lets an owner change anyone's role, and audits it", async () => {
    const t = await team("chg");
    expect((await change(t.owner, t.orgId, t.operator.id, "admin")).error).toBeNull();
    expect(await roleOf(t.orgId, t.operator.id)).toBe("admin");
    expect((await change(t.owner, t.orgId, t.viewer.id, "operator")).error).toBeNull();
    expect(await roleOf(t.orgId, t.viewer.id)).toBe("operator");
    const { rows } = await pool.query(
      `select actor_user_id, metadata from public.audit_logs where organisation_id = $1 and action = 'member.role_changed' order by id`,
      [t.orgId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].actor_user_id).toBe(t.owner.id);
    expect(rows[0].metadata).toMatchObject({ from: "operator", to: "admin" });
  });

  it("lets an admin move operators and viewers between those two roles", async () => {
    const t = await team("chgadm");
    expect((await change(t.admin, t.orgId, t.viewer.id, "operator")).error).toBeNull();
    expect((await change(t.admin, t.orgId, t.operator.id, "viewer")).error).toBeNull();
    expect(await roleOf(t.orgId, t.viewer.id)).toBe("operator");
    expect(await roleOf(t.orgId, t.operator.id)).toBe("viewer");
  });

  it("keeps ownership with owners: admins cannot grant it, take it, or hand out admin", async () => {
    const t = await team("chgown");
    for (const [target, role] of [
      [t.operator.id, "owner"],
      [t.admin.id, "owner"],
      [t.owner.id, "admin"],
      [t.owner.id, "viewer"],
      [t.operator.id, "admin"],
    ] as const) {
      const res = await change(t.admin, t.orgId, target, role);
      expect(res.error, `${target} -> ${role}`).not.toBeNull();
    }
    expect(await roleOf(t.orgId, t.owner.id)).toBe("owner");
    expect(await roleOf(t.orgId, t.operator.id)).toBe("operator");
    expect(await roleOf(t.orgId, t.admin.id)).toBe("admin");
  });

  it("refuses operators, viewers and outsiders", async () => {
    const t = await team("chgno");
    const outsider = await createUser("chg-outsider");
    for (const caller of [t.operator, t.viewer, outsider]) {
      const res = await change(caller, t.orgId, t.viewer.id, "operator");
      expect(res.error).not.toBeNull();
    }
    expect(await roleOf(t.orgId, t.viewer.id)).toBe("viewer");
  });

  it("does not reach into another organisation", async () => {
    const a = await team("chgx-a");
    const b = await team("chgx-b");
    expect((await change(a.owner, b.orgId, b.viewer.id, "operator")).error).not.toBeNull();
    expect((await change(a.owner, a.orgId, b.viewer.id, "operator")).error?.message).toMatch(/not a member/i);
    expect(await roleOf(b.orgId, b.viewer.id)).toBe("viewer");
  });

  it("transfers ownership: make someone an owner, then step down", async () => {
    const t = await team("xfer");
    expect((await change(t.owner, t.orgId, t.admin.id, "owner")).error).toBeNull();
    expect((await change(t.owner, t.orgId, t.owner.id, "admin")).error).toBeNull();
    expect(await roleOf(t.orgId, t.admin.id)).toBe("owner");
    expect(await roleOf(t.orgId, t.owner.id)).toBe("admin");
    // The former owner can no longer act as one.
    expect((await change(t.owner, t.orgId, t.admin.id, "viewer")).error).not.toBeNull();
  });

  it("never leaves an organisation without an owner", async () => {
    const t = await team("last");
    const res = await change(t.owner, t.orgId, t.owner.id, "admin");
    expect(res.error?.message).toMatch(/at least one owner/i);
    expect(await roleOf(t.orgId, t.owner.id)).toBe("owner");
  });

  it("holds under concurrency: two owners cannot demote each other at once", async () => {
    for (let round = 0; round < 3; round++) {
      const t = await team(`race${round}`);
      expect((await change(t.owner, t.orgId, t.admin.id, "owner")).error).toBeNull();
      const results = await Promise.all([change(t.owner, t.orgId, t.admin.id, "viewer"), change(t.admin, t.orgId, t.owner.id, "viewer")]);
      expect(
        results.filter((r) => r.error === null),
        `round ${round}`,
      ).toHaveLength(1);
      expect(await count(`select 1 from public.organisation_members where organisation_id = $1 and role = 'owner'`, [t.orgId])).toBe(1);
    }
  });

  it("takes the mailbox credential and the pairing codes of someone who drops below admin", async () => {
    const t = await team("demote");
    const mailbox = await t.admin.client.rpc("connect_email_account", {
      p_org: t.orgId,
      p_provider: "SMTP",
      p_from: t.admin.email,
      p_display_name: "Admin",
      p_secret: JSON.stringify({ password: "mailbox-password-123" }),
      p_smtp_host: "smtp.acme.co.za",
      p_smtp_port: 587,
      p_smtp_username: t.admin.email,
    });
    expect(mailbox.error).toBeNull();
    const { rows } = await pool.query<{ secret_id: string }>(`select secret_id from public.email_accounts where id = $1`, [mailbox.data]);
    expect((await t.admin.client.rpc("create_autofill_token", { p_org: t.orgId, p_label: "laptop" })).error).toBeNull();

    expect((await change(t.owner, t.orgId, t.admin.id, "viewer")).error).toBeNull();
    expect(await count(`select 1 from public.email_accounts where id = $1 and revoked_at is not null`, [mailbox.data])).toBe(1);
    expect(await count(`select 1 from vault.secrets where id = $1`, [rows[0].secret_id])).toBe(0);
    expect(await count(`select 1 from public.autofill_tokens where user_id = $1 and revoked_at is null`, [t.admin.id])).toBe(0);
  });
});

describe("remove_member", () => {
  it("removes a member, revokes their pairing codes, disconnects their mailbox and audits it", async () => {
    const t = await team("rm");
    const mailbox = await t.admin.client.rpc("connect_email_account", {
      p_org: t.orgId,
      p_provider: "SMTP",
      p_from: t.admin.email,
      p_display_name: "Admin",
      p_secret: JSON.stringify({ password: "mailbox-password-123" }),
      p_smtp_host: "smtp.acme.co.za",
      p_smtp_port: 587,
      p_smtp_username: t.admin.email,
    });
    expect(mailbox.error).toBeNull();
    const { rows: acc } = await pool.query<{ secret_id: string }>(`select secret_id from public.email_accounts where id = $1`, [mailbox.data]);
    const code = await t.admin.client.rpc("create_autofill_token", { p_org: t.orgId, p_label: "laptop" });
    expect(code.error).toBeNull();
    const hash = (await pool.query<{ h: string }>(`select encode(extensions.digest($1, 'sha256'), 'hex') as h`, [code.data])).rows[0].h;
    expect((await admin().rpc("resolve_autofill_token", { p_hash: hash } as never)).data).toHaveLength(1);

    expect((await remove(t.owner, t.orgId, t.admin.id)).error).toBeNull();

    expect(await roleOf(t.orgId, t.admin.id)).toBeNull();
    expect((await admin().rpc("resolve_autofill_token", { p_hash: hash } as never)).data).toEqual([]);
    expect(await count(`select 1 from public.autofill_tokens where token_hash = $1 and revoked_at is null`, [hash])).toBe(0);
    expect(await count(`select 1 from public.email_accounts where id = $1 and revoked_at is null`, [mailbox.data])).toBe(0);
    expect(await count(`select 1 from vault.secrets where id = $1`, [acc[0].secret_id])).toBe(0);
    const { rows } = await pool.query(`select actor_user_id, metadata from public.audit_logs where organisation_id = $1 and action = 'member.removed'`, [
      t.orgId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe(t.owner.id);
    expect(rows[0].metadata).toMatchObject({ role: "admin", pairing_codes_revoked: 1, mailboxes_disconnected: 1 });
  });

  it("frees the person to join or create another organisation", async () => {
    const t = await team("rmfree");
    expect((await remove(t.owner, t.orgId, t.viewer.id)).error).toBeNull();
    await expect(bootstrapOrg(t.viewer)).resolves.toEqual(expect.any(String));
  });

  it("lets an admin remove operators and viewers, but not owners", async () => {
    const t = await team("rmadm");
    expect((await remove(t.admin, t.orgId, t.owner.id)).error).not.toBeNull();
    expect((await remove(t.admin, t.orgId, t.operator.id)).error).toBeNull();
    expect((await remove(t.admin, t.orgId, t.viewer.id)).error).toBeNull();
    expect(await roleOf(t.orgId, t.owner.id)).toBe("owner");
    expect(await roleOf(t.orgId, t.operator.id)).toBeNull();
  });

  it("refuses operators and viewers removing anyone else, and outsiders removing anyone", async () => {
    const t = await team("rmno");
    const outsider = await createUser("rm-outsider");
    for (const [caller, target] of [
      [t.operator, t.viewer],
      [t.viewer, t.operator],
      [outsider, t.viewer],
    ] as const) {
      expect((await remove(caller, t.orgId, target.id)).error).not.toBeNull();
    }
    expect(await roleOf(t.orgId, t.viewer.id)).toBe("viewer");
    expect(await roleOf(t.orgId, t.operator.id)).toBe("operator");
  });

  it("lets any member leave, so someone invited elsewhere is never stuck", async () => {
    const t = await team("leave");
    expect((await remove(t.viewer, t.orgId, t.viewer.id)).error).toBeNull();
    expect((await remove(t.operator, t.orgId, t.operator.id)).error).toBeNull();
    expect(await roleOf(t.orgId, t.viewer.id)).toBeNull();
    expect(await roleOf(t.orgId, t.operator.id)).toBeNull();
  });

  it("never removes the last owner, whoever asks, and tells them what to do", async () => {
    const t = await team("rmlast");
    const self = await remove(t.owner, t.orgId, t.owner.id);
    expect(self.error?.message).toMatch(/at least one owner/i);
    expect(await roleOf(t.orgId, t.owner.id)).toBe("owner");
  });

  it("lets an owner leave once another owner exists", async () => {
    const t = await team("rmleaveown");
    expect((await change(t.owner, t.orgId, t.admin.id, "owner")).error).toBeNull();
    expect((await remove(t.owner, t.orgId, t.owner.id)).error).toBeNull();
    expect(await roleOf(t.orgId, t.owner.id)).toBeNull();
  });

  it("holds under concurrency: two owners cannot remove each other at once", async () => {
    for (let round = 0; round < 3; round++) {
      const t = await team(`rmrace${round}`);
      expect((await change(t.owner, t.orgId, t.admin.id, "owner")).error).toBeNull();
      const results = await Promise.all([remove(t.owner, t.orgId, t.admin.id), remove(t.admin, t.orgId, t.owner.id)]);
      expect(
        results.filter((r) => r.error === null),
        `round ${round}`,
      ).toHaveLength(1);
      expect(await count(`select 1 from public.organisation_members where organisation_id = $1 and role = 'owner'`, [t.orgId])).toBe(1);
    }
  });

  it("says plainly when the person is not a member", async () => {
    const t = await team("rmghost");
    const res = await remove(t.owner, t.orgId, randomUUID());
    expect(res.error?.message).toMatch(/not a member/i);
  });
});

describe("the last-owner trigger", () => {
  it("stops any other path from leaving an organisation without an owner", async () => {
    const t = await team("trg");
    await expect(
      pool.query(`update public.organisation_members set role = 'admin' where organisation_id = $1 and user_id = $2`, [t.orgId, t.owner.id]),
    ).rejects.toThrow(/at least one owner/i);
    await expect(pool.query(`delete from public.organisation_members where organisation_id = $1 and user_id = $2`, [t.orgId, t.owner.id])).rejects.toThrow(
      /at least one owner/i,
    );
    expect(await roleOf(t.orgId, t.owner.id)).toBe("owner");
  });

  it("lets an owner go while another remains", async () => {
    const t = await team("trg2");
    await addMember(t.orgId, (await createUser("trg2-second")).id, "owner", pool);
    await pool.query(`update public.organisation_members set role = 'admin' where organisation_id = $1 and user_id = $2`, [t.orgId, t.owner.id]);
    expect(await roleOf(t.orgId, t.owner.id)).toBe("admin");
  });

  it("lets deleting the organisation take its owner with it", async () => {
    const owner = await createUser("trg-cascade");
    const { rows } = await pool.query<{ id: string }>(`insert into public.organisations (name, slug) values ('Cascade Test', $1) returning id`, [
      `cascade-${randomUUID().slice(0, 12)}`,
    ]);
    await addMember(rows[0].id, owner.id, "owner", pool);
    await pool.query(`delete from public.organisations where id = $1`, [rows[0].id]);
    expect(await count(`select 1 from public.organisation_members where user_id = $1`, [owner.id])).toBe(0);
  });

  it("does not get in the way of erasing the organisation or its owner", async () => {
    const t = await team("trg3");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.erasure', 'on', true)`);
      await client.query(`delete from public.organisation_members where organisation_id = $1`, [t.orgId]);
      await client.query("rollback");
    } finally {
      client.release();
    }
  });
});
