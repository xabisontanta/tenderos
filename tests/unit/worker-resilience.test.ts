import { describe, expect, it, vi } from "vitest";
import { Worker } from "@/workflows/worker";
import type { Job } from "@/workflows/engine";

function fakeLogger() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

const job = { id: "job-1", kind: "task.run", attempts: 1, max_attempts: 3 } as unknown as Job;

/** A pool whose job-status writes fail, like a database blip right after a step ran. */
function flakyPool() {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (/update public\.jobs/i.test(sql)) throw new Error("connection terminated unexpectedly");
    return { rows: [] as unknown[] };
  });
  return { query, connect: vi.fn() };
}

function workerWith(pool: ReturnType<typeof flakyPool>, logger = fakeLogger()) {
  const worker = new Worker(pool as never, { concurrency: 1, simulationStepMs: 0, logger: logger as never });
  // The engine is irrelevant here: only the worker's own bookkeeping is under test.
  (worker as unknown as { engine: unknown }).engine = {
    handle: vi.fn(async () => ({ status: "completed" })),
    onJobDead: vi.fn(async () => undefined),
  };
  return { worker, logger };
}

describe("Worker resilience", () => {
  it("does not reject when recording the job outcome fails", async () => {
    const { worker, logger } = workerWith(flakyPool());
    const process = (worker as unknown as { process: (j: Job) => Promise<void> }).process.bind(worker);

    await expect(process(job)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("could not record job outcome", expect.objectContaining({ error: "connection terminated unexpectedly" }));
  });

  it("does not count a job whose outcome could not be recorded", async () => {
    const { worker } = workerWith(flakyPool());
    const process = (worker as unknown as { process: (j: Job) => Promise<void> }).process.bind(worker);

    await process(job);

    expect((worker as unknown as { processed: number }).processed).toBe(0);
  });

  it("keeps draining after a failed outcome write instead of throwing", async () => {
    const pool = flakyPool();
    const writes = pool.query;
    let claims = 0;
    pool.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (/claim_job/i.test(sql)) return { rows: claims++ === 0 ? [job] : [] };
      return writes(sql, params);
    });
    const { worker } = workerWith(pool);

    await expect(worker.drain(5)).resolves.toBe(1);
  });
});
