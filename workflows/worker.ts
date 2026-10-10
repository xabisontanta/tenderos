import { hostname } from "node:os";
import type { Pool, PoolClient } from "@/lib/db/pool";
import type { Logger } from "@/lib/log";
import { backoffMs } from "./retry";
import { WorkflowEngine, type Job, type JobOutcome } from "./engine";

export interface WorkerOptions {
  concurrency: number;
  simulationStepMs: number;
  logger: Logger;
  /** Fallback poll interval when no NOTIFY arrives. */
  idlePollMs?: number;
}

/**
 * Postgres-backed job worker. Claims jobs with FOR UPDATE SKIP LOCKED (safe
 * with many workers), wakes on LISTEN/NOTIFY instead of tight polling, and
 * drains in-flight jobs on shutdown.
 */
export class Worker {
  readonly id = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  private readonly engine: WorkflowEngine;
  private running = false;
  private inFlight = new Set<Promise<void>>();
  private wake: (() => void) | null = null;
  private listener: PoolClient | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly opts: WorkerOptions,
  ) {
    this.engine = new WorkflowEngine(pool, { simulationStepMs: opts.simulationStepMs, logger: opts.logger });
  }

  async start(): Promise<void> {
    this.running = true;
    this.listener = await this.pool.connect();
    await this.listener.query("listen tenderos_jobs");
    this.listener.on("notification", () => this.wake?.());
    this.opts.logger.info("worker started", { worker_id: this.id, concurrency: this.opts.concurrency });
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await Promise.allSettled([...this.inFlight]);
    if (this.listener) {
      await this.listener.query("unlisten tenderos_jobs").catch(() => undefined);
      this.listener.release();
      this.listener = null;
    }
    this.opts.logger.info("worker stopped", { worker_id: this.id });
  }

  /** Process ready jobs until none remain. Used by tests and one-shot runs. */
  async drain(maxJobs = 1000): Promise<number> {
    let n = 0;
    while (n < maxJobs) {
      const job = await this.claim();
      if (!job) break;
      await this.process(job);
      n++;
    }
    return n;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (this.inFlight.size >= this.opts.concurrency) {
        await Promise.race(this.inFlight);
        continue;
      }
      let job: Job | null = null;
      try {
        job = await this.claim();
      } catch (err) {
        this.opts.logger.error("claim failed", { error: (err as Error).message });
      }
      if (!job) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.opts.idlePollMs ?? 5000);
          this.wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        this.wake = null;
        continue;
      }
      const p = this.process(job).finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
  }

  private async claim(): Promise<Job | null> {
    const { rows } = await this.pool.query<Job>(`select * from private.claim_job($1)`, [this.id]);
    return rows[0] ?? null;
  }

  private async process(job: Job): Promise<void> {
    const log = this.opts.logger.child({ job_id: job.id, kind: job.kind });
    let outcome: JobOutcome;
    try {
      outcome = await this.engine.handle(job);
    } catch (err) {
      const message = (err as Error).message;
      log.error("job crashed", { error: message, attempts: job.attempts });
      outcome =
        job.attempts >= job.max_attempts
          ? { status: "dead", error: message }
          : { status: "retry", runAt: new Date(Date.now() + backoffMs(job.attempts)), error: message };
    }
    if (outcome.status === "dead" && job.kind === "task.run") {
      await this.engine.onJobDead(job, outcome.error).catch((err) => log.error("dead-letter handling failed", { error: (err as Error).message }));
    }
    await this.finish(job, outcome);
    log.debug("job finished", { outcome: outcome.status });
  }

  private async finish(job: Job, o: JobOutcome): Promise<void> {
    switch (o.status) {
      case "completed":
        await this.pool.query(`update public.jobs set status = 'COMPLETED', completed_at = now(), locked_at = null where id = $1`, [job.id]);
        break;
      case "retry":
        await this.pool.query(
          `update public.jobs set status = 'QUEUED', run_at = $2, locked_at = null, locked_by = null, last_error = $3 where id = $1`,
          [job.id, o.runAt.toISOString(), o.error.slice(0, 2000)],
        );
        break;
      case "defer":
        // Deferral is not a failed attempt.
        await this.pool.query(
          `update public.jobs set status = 'QUEUED', run_at = $2, locked_at = null, locked_by = null,
                  attempts = greatest(attempts - 1, 0), last_error = $3 where id = $1`,
          [job.id, o.runAt.toISOString(), o.reason],
        );
        break;
      case "dead":
        // Dead-letter: kept for inspection and manual retry.
        await this.pool.query(`update public.jobs set status = 'DEAD', locked_at = null, last_error = $2 where id = $1`, [job.id, o.error.slice(0, 2000)]);
        break;
    }
  }
}
