# ADR 0002: Postgres job queue instead of Temporal

**Status:** accepted

**Context.** Agent work is long-running, must survive restarts, retry with
backoff, and be visible in the UI.

**Decision.** A `jobs` table claimed with `FOR UPDATE SKIP LOCKED`, woken by
`LISTEN/NOTIFY`, with idempotency keys, stale-lock reclaim and a dead-letter
state. Each step commits its output, events, next task, handoff and next job
in one transaction.

**Consequences.** One database to operate and back up; queue state joins
directly with tasks and runs. Throughput is bounded by Postgres, which is
far beyond tender volumes. If workflows grow long timers or complex
compensation, revisit Temporal; the engine's job handlers are the seam.
