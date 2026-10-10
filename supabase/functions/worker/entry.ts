// Edge Function entry point, bundled by scripts/build-edge-worker.ts into
// supabase/functions/worker/index.ts. A pg_cron job calls it every minute;
// each call works through ready jobs for up to RUN_BUDGET_MS. The function
// keeps JWT verification on and also requires the Vault-held worker secret.
import { createPool } from "@/lib/db/pool";
import { createLogger } from "@/lib/log";
import { Worker } from "@/workflows/worker";

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Promise<Response>): void };

const RUN_BUDGET_MS = Number(Deno.env.get("RUN_BUDGET_MS") ?? 45_000);
const STEP_MS = Number(Deno.env.get("SIMULATION_STEP_MS") ?? 1500);

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  const given = req.headers.get("x-worker-secret") ?? "";
  if (!given) return new Response("forbidden", { status: 403 });

  const logger = createLogger({ service: "tenderos-edge-worker" }, "info");
  const pool = createPool(Deno.env.get("SUPABASE_DB_URL")!, 4);
  try {
    // The shared secret lives in Supabase Vault, where the pg_cron job that
    // calls this function also reads it.
    const { rows } = await pool.query<{ secret: string }>(
      `select decrypted_secret as secret from vault.decrypted_secrets where name = 'tenderos_worker_secret'`,
    );
    if (!rows[0] || !sameSecret(given, rows[0].secret)) return new Response("forbidden", { status: 403 });

    const worker = new Worker(pool, { concurrency: 2, simulationStepMs: STEP_MS, logger });
    const processed = await worker.runFor(RUN_BUDGET_MS);
    return Response.json({ processed });
  } catch (err) {
    logger.error("edge worker failed", { error: (err as Error).message });
    return Response.json({ error: "worker failed" }, { status: 500 });
  } finally {
    await pool.end().catch(() => undefined);
  }
});
