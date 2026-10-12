-- A scan now says how many rows the portal sent and how many it could not use (docs/production-readiness.md,
-- P0 #12). Rows that failed validation used to be dropped without a trace, so a portal that changed its format
-- looked like "completed, 0 matched".
--
--   rows_seen     every row the portal sent
--   rows_skipped  rows that could not become a tender because they were malformed (unreadable, no closing date,
--                 no issuing organisation) or that the database refused; not tenders that have already closed
--
-- `scanned` keeps its meaning: rows that could be read.
alter table public.discovery_runs
  add column rows_seen integer not null default 0 check (rows_seen >= 0),
  add column rows_skipped integer not null default 0 check (rows_skipped >= 0),
  add constraint discovery_runs_skipped_within_seen check (rows_skipped <= rows_seen);
