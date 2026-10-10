import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { createPool, type Pool } from "@/lib/db/pool";
import { createLogger } from "@/lib/log";
import { registryPayload } from "@/lib/org/bootstrap";
import { Worker } from "@/workflows/worker";

export type Client = SupabaseClient<Database>;

export const env = () => ({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  service: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  db: process.env.DATABASE_URL!,
});

export function admin(): Client {
  return createClient<Database>(env().url, env().service, { auth: { persistSession: false, autoRefreshToken: false } });
}

export interface TestUser {
  id: string;
  email: string;
  client: Client;
}

/** Creates a confirmed auth user and returns a client signed in as them. */
export async function createUser(prefix = "user"): Promise<TestUser> {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@tenderos.test`;
  const password = `Pw-${randomUUID()}`;
  const { data, error } = await admin().auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient<Database>(env().url, env().anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, email, client };
}

export async function bootstrapOrg(user: TestUser, name = `Test Org ${randomUUID().slice(0, 6)}`): Promise<string> {
  const { data, error } = await admin().rpc("bootstrap_organisation", {
    p_user_id: user.id,
    p_name: name,
    p_slug: `test-${randomUUID().slice(0, 12)}`,
    ...registryPayload(),
  } as never);
  if (error) throw error;
  return data as unknown as string;
}

export async function addMember(orgId: string, userId: string, role: Database["public"]["Enums"]["org_role"], pool: Pool) {
  await pool.query(`insert into public.organisation_members (organisation_id, user_id, role) values ($1, $2, $3)`, [orgId, userId, role]);
}

export function futureIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export async function createTender(client: Client, orgId: string, overrides: Partial<Database["public"]["Tables"]["tenders"]["Insert"]> = {}) {
  const { data, error } = await client
    .from("tenders")
    .insert({
      organisation_id: orgId,
      title: "Supply of office furniture (simulation)",
      issuing_organisation: "Test Municipality",
      closing_at: futureIso(14),
      submission_method: "ELECTRONIC_PORTAL",
      province: "GAUTENG",
      is_simulation: true,
      ...overrides,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export function testPool(): Pool {
  return createPool(env().db, 6);
}

export function testWorker(pool: Pool): Worker {
  return new Worker(pool, { concurrency: 1, simulationStepMs: 0, logger: createLogger({ service: "test" }, "error") });
}

/**
 * Processes all jobs for an organisation, fast-forwarding delayed retries,
 * until nothing is runnable. Deferred jobs (paused agent, kill switch) are
 * left alone unless includeDeferred is set.
 */
export async function drainOrg(worker: Worker, pool: Pool, orgId: string, rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await pool.query(
      `update public.jobs set run_at = now() where organisation_id = $1 and status = 'QUEUED' and run_at > now()
         and coalesce(last_error, '') not in ('Agent paused by operator', 'Agent disabled', 'Emergency kill switch engaged')`,
      [orgId],
    );
    const n = await worker.drain();
    const { rows } = await pool.query(
      `select count(*)::int as n from public.jobs where organisation_id = $1 and status = 'QUEUED' and run_at <= now()`,
      [orgId],
    );
    if (n === 0 && rows[0].n === 0) {
      const { rows: delayed } = await pool.query(
        `select count(*)::int as n from public.jobs where organisation_id = $1 and status = 'QUEUED'
           and coalesce(last_error, '') not in ('Agent paused by operator', 'Agent disabled', 'Emergency kill switch engaged')`,
        [orgId],
      );
      if (delayed[0].n === 0) return;
    }
  }
}
