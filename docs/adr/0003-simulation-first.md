# ADR 0003: Simulation first, deterministic executors

**Status:** accepted

**Context.** The interface must show real agent work without fake data, but
no AI provider or company data exists yet.

**Decision.** Executors are deterministic functions of the tender record.
They mark everything they cannot know as `MISSING_INFORMATION` or
`REQUIRES_CONFIRMATION`, record $0 simulated cost, and only run for tenders
flagged simulation while the organisation is in simulation mode.

**Consequences.** The whole pipeline, including failures and approvals, is
testable end to end today. Real AI executors replace `simulated.ts` behind
the same schema and permission checks.
