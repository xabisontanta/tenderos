import { config } from "dotenv";
import { createPool } from "@/lib/db/pool";
import { workerEnv } from "@/lib/env";
import { createLogger } from "@/lib/log";
import { Worker } from "@/workflows/worker";

config({ path: [".env.local", ".env"], quiet: true });

// If whoever reads our logs goes away (a closed pipe), keep shutting down cleanly instead of crashing.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EPIPE") throw err;
});

async function main() {
  const env = workerEnv();
  const logger = createLogger({ service: "tenderos-worker" }, env.LOG_LEVEL);
  const pool = createPool(env.DATABASE_URL, env.WORKER_CONCURRENCY + 2);
  const worker = new Worker(pool, { concurrency: env.WORKER_CONCURRENCY, simulationStepMs: env.SIMULATION_STEP_MS, logger });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { signal });
    await worker.stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await worker.start();
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "error", msg: "worker failed to start", error: (err as Error).message }));
  process.exit(1);
});
