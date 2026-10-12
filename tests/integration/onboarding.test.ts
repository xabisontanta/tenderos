import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import { addMember, bootstrapOrg, createUser, testPool, type TestUser } from "./helpers";

let pool: Pool;
let owner: TestUser;
let operator: TestUser;
let outsider: TestUser;
let orgId: string;

beforeAll(async () => {
  pool = testPool();
  owner = await createUser("onb-owner");
  operator = await createUser("onb-operator");
  outsider = await createUser("onb-outsider");
  orgId = await bootstrapOrg(owner);
  await addMember(orgId, operator.id, "operator", pool);
  await bootstrapOrg(outsider);
});

afterAll(async () => {
  await pool.end();
});

const saveKeywords = (keywords: string[]) =>
  owner.client.from("company_profiles").upsert({ organisation_id: orgId, keywords } as never, { onConflict: "organisation_id" });

describe("company keywords", () => {
  it("default to none", async () => {
    const { rows } = await pool.query(`select keywords from public.company_profiles where organisation_id = $1`, [orgId]);
    expect(rows[0]?.keywords ?? []).toEqual([]);
  });

  it("accept up to 50 keywords of 2 to 60 characters", async () => {
    expect((await saveKeywords(["ab", "x".repeat(60), "road maintenance"])).error).toBeNull();
    expect((await saveKeywords(Array.from({ length: 50 }, (_, i) => `keyword ${i}`))).error).toBeNull();
    const { rows } = await pool.query(`select cardinality(keywords)::int as n from public.company_profiles where organisation_id = $1`, [orgId]);
    expect(rows[0].n).toBe(50);
  });

  it.each([
    ["a 51st keyword", Array.from({ length: 51 }, (_, i) => `keyword ${i}`)],
    ["a one-character keyword", ["a"]],
    ["a 61-character keyword", ["x".repeat(61)]],
    ["an empty keyword", [""]],
    ["a keyword with surrounding spaces", [" paving"]],
    ["a keyword with a control character", ["pav\u0007ing"]],
  ])("refuse %s", async (_name, keywords) => {
    const { error } = await saveKeywords(keywords);
    expect(error?.code).toBe("23514");
  });

  it("are saved by owners and admins only, like the rest of the profile", async () => {
    const { error } = await operator.client
      .from("company_profiles")
      .upsert({ organisation_id: orgId, keywords: ["paving"] } as never, { onConflict: "organisation_id" });
    expect(error).not.toBeNull();
  });
});

describe("complete_onboarding", () => {
  it("is null until onboarding is finished", async () => {
    const fresh = await createUser("onb-fresh");
    const id = await bootstrapOrg(fresh);
    const { rows } = await pool.query(`select onboarding_completed_at from public.system_settings where organisation_id = $1`, [id]);
    expect(rows[0].onboarding_completed_at).toBeNull();
  });

  it("is stamped once by an owner, and a second call keeps the first time", async () => {
    const user = await createUser("onb-done");
    const id = await bootstrapOrg(user);
    expect((await user.client.rpc("complete_onboarding", { p_org: id })).error).toBeNull();
    const first = (await pool.query(`select onboarding_completed_at from public.system_settings where organisation_id = $1`, [id])).rows[0]
      .onboarding_completed_at;
    expect(first).toBeTruthy();
    expect((await user.client.rpc("complete_onboarding", { p_org: id })).error).toBeNull();
    const second = (await pool.query(`select onboarding_completed_at from public.system_settings where organisation_id = $1`, [id])).rows[0]
      .onboarding_completed_at;
    expect(second).toBe(first);
    const audit = await pool.query(`select count(*)::int as n from public.audit_logs where organisation_id = $1 and action = 'onboarding.completed'`, [id]);
    expect(audit.rows[0].n).toBe(1);
  });

  it("is refused to operators and to people outside the organisation", async () => {
    expect((await operator.client.rpc("complete_onboarding", { p_org: orgId })).error?.code).toBe("42501");
    expect((await outsider.client.rpc("complete_onboarding", { p_org: orgId })).error?.code).toBe("42501");
    const { rows } = await pool.query(`select onboarding_completed_at from public.system_settings where organisation_id = $1`, [orgId]);
    expect(rows[0].onboarding_completed_at).toBeNull();
  });

  it("is rate limited", async () => {
    const user = await createUser("onb-spam");
    const id = await bootstrapOrg(user);
    let last;
    for (let i = 0; i < 21; i++) last = await user.client.rpc("complete_onboarding", { p_org: id });
    expect(last!.error?.code).toBe("P0429");
  });
});

describe("automatic workflows", () => {
  it("are off for a new organisation, so skipping onboarding does not start bids nobody asked for", async () => {
    const { rows } = await pool.query(`select auto_run_workflows from public.system_settings where organisation_id = $1`, [orgId]);
    expect(rows[0].auto_run_workflows).toBe(false);
  });

  it("stay off when the wizard saves provinces", async () => {
    const { error } = await owner.client.rpc("set_watched_provinces", { p_org: orgId, p_provinces: ["GAUTENG", "WESTERN_CAPE"], p_auto_run: false });
    expect(error).toBeNull();
    const { rows } = await pool.query(`select watched_provinces, auto_run_workflows from public.system_settings where organisation_id = $1`, [orgId]);
    expect(rows[0]).toEqual({ watched_provinces: ["GAUTENG", "WESTERN_CAPE"], auto_run_workflows: false });
  });
});
