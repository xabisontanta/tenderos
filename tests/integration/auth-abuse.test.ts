import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "@/lib/db/pool";
import type { Database } from "@/types/database";
import { admin, env, testPool } from "./helpers";

vi.mock("server-only", () => ({}));

let pool: Pool;

beforeAll(() => {
  pool = testPool();
});

afterAll(async () => {
  await pool.end();
});

const hex = () => randomUUID().replaceAll("-", "").repeat(2); // 64 hex chars

describe("hit_rate_limit_key for auth subjects", () => {
  it("counts per subject and refuses past the limit", async () => {
    const key = `auth_ip:${hex()}`;
    for (let i = 0; i < 3; i++) {
      const { error } = await admin().rpc("hit_rate_limit_key", { p_key: key, p_action: "auth.signup", p_max: 3, p_window_seconds: 60 });
      expect(error).toBeNull();
    }
    const { error } = await admin().rpc("hit_rate_limit_key", { p_key: key, p_action: "auth.signup", p_max: 3, p_window_seconds: 60 });
    expect(error?.code).toBe("P0429");
    // A different subject, and the same subject for another action, are unaffected.
    expect((await admin().rpc("hit_rate_limit_key", { p_key: `auth_ip:${hex()}`, p_action: "auth.signup", p_max: 3, p_window_seconds: 60 })).error).toBeNull();
    expect((await admin().rpc("hit_rate_limit_key", { p_key: key, p_action: "auth.signin", p_max: 3, p_window_seconds: 60 })).error).toBeNull();
  });

  it("cannot hold a raw email or address as a subject", async () => {
    for (const key of ["auth_email:thandi@example.test", "auth_ip:41.0.0.9", "auth_ip:2001:db8::1"]) {
      const { error } = await admin().rpc("hit_rate_limit_key", { p_key: key, p_action: "auth.signin", p_max: 3, p_window_seconds: 60 });
      expect(error?.code, key).toBe("23514");
    }
  });

  it("is not callable by browsers", async () => {
    const anon = createClient<Database>(env().url, env().anon, { auth: { persistSession: false } });
    const { error } = await anon.rpc("hit_rate_limit_key", { p_key: `auth_ip:${hex()}`, p_action: "auth.signin", p_max: 3, p_window_seconds: 60 });
    expect(error).not.toBeNull();
  });

  it("is the limiter the app uses: the sixth sign-up from one address is refused, and the database holds only hashes", async () => {
    vi.stubEnv("TRUSTED_IP_HEADER", "x-vercel-forwarded-for");
    vi.stubEnv("AUTH_RATE_LIMIT_SECRET", "integration-test-secret-".padEnd(40, "x"));
    const { limitAuthAttempt } = await import("@/lib/auth/rate-limit");
    const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
    const headers = new Headers({ "x-vercel-forwarded-for": ip });
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await limitAuthAttempt("signup", { email: `limit-${randomUUID()}@example.test`, headers }));
    expect(results.slice(0, 5).every((r) => r.ok)).toBe(true);
    expect(results[5]).toEqual({ ok: false, reason: "limited" });

    const { rows } = await pool.query(`select key from private.rate_limits where key like 'auth\\_%' and window_start > now() - interval '5 minutes'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.key).toMatch(/^auth_(ip|email):[0-9a-f]{64}:auth\.[a-z]+$/);
      expect(r.key).not.toContain("example.test");
      expect(r.key).not.toContain(ip);
    }
    vi.unstubAllEnvs();
  });
});

describe("rate limit sweeper", () => {
  it("removes rows whose window ended more than a day ago and keeps the rest", async () => {
    const old = `sweep_old:${hex()}:test.sweep`;
    const fresh = `sweep_new:${hex()}:test.sweep`;
    await pool.query(
      `insert into private.rate_limits (key, window_start, count) values ($1, now() - interval '25 hours', 3), ($2, now() - interval '10 minutes', 1)`,
      [old, fresh],
    );
    const { rows } = await pool.query(`select private.sweep_rate_limits() as n`);
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
    const left = await pool.query(`select key from private.rate_limits where key = any($1)`, [[old, fresh]]);
    expect(left.rows.map((r) => r.key)).toEqual([fresh]);
  });

  it("is scheduled hourly and not callable by browsers", async () => {
    const job = await pool.query(`select schedule, command from cron.job where jobname = 'tenderos-sweep-rate-limits'`);
    expect(job.rows).toEqual([{ schedule: "17 * * * *", command: "select private.sweep_rate_limits()" }]);
    // private is not an exposed schema, and execute is revoked from every API role.
    const { rows } = await pool.query(
      `select has_function_privilege('anon', 'private.sweep_rate_limits()', 'execute') as anon,
              has_function_privilege('authenticated', 'private.sweep_rate_limits()', 'execute') as authenticated`,
    );
    expect(rows[0]).toEqual({ anon: false, authenticated: false });
  });
});
