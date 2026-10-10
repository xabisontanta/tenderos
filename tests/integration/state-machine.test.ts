import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import { ALL_TENDER_STATUSES, canTransition } from "@/lib/domain/tender-state";
import { testPool } from "./helpers";

let pool: Pool;
beforeAll(() => {
  pool = testPool();
});
afterAll(async () => {
  await pool.end();
});

describe("tender state machine parity", () => {
  it("TypeScript and SQL transition tables agree for every pair", async () => {
    const { rows } = await pool.query<{ f: string; t: string; ok: boolean }>(
      `select f::text as f, t::text as t, private.tender_transition_allowed(f, t) as ok
         from unnest(enum_range(null::public.tender_status)) f, unnest(enum_range(null::public.tender_status)) t`,
    );
    expect(rows.length).toBe(ALL_TENDER_STATUSES.length ** 2);
    const mismatches = rows.filter((r) => r.ok !== canTransition(r.f as never, r.t as never)).map((r) => `${r.f}->${r.t}`);
    expect(mismatches).toEqual([]);
  });
});
