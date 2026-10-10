# TenderOS

A multi-agent tender management platform for South African businesses. AI
agents, organised as a tender department, find, analyse, qualify and prepare
bids, with people approving every submission. The interface shows the real
state of that work as it happens: which agent is doing what, every handoff,
and everything that needs a decision.

**Status:** Milestone 1 (foundation and simulated workflow) is complete. Agents
run deterministic, simulated steps; no AI provider is called and nothing is
submitted outside the system. See `docs/roadmap.md`.

## Stack

Next.js 15 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS v4 ·
shadcn-style components on Radix · Supabase (Postgres, Auth, Realtime, RLS) ·
Postgres-backed job queue and Node worker · Vitest · Playwright.

## Run it locally

Requirements: Node 22, Docker, the Supabase CLI (installed as a dev dependency).

```bash
npm install
npm run db:start      # starts local Supabase and applies migrations
npm run db:env        # writes .env.local from the local stack (gitignored)
npm run dev           # http://localhost:3000
npm run worker        # in a second terminal: runs agent work
```

Sign up, name your organisation, create a tender with "Simulation" ticked,
and press **Start simulated workflow**. Watch it in Office and Operations, then
approve it on the Approvals page.

## Scripts

| Script                                                                | What it does                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `dev`, `build`, `start`                                               | Next.js                                                     |
| `worker`                                                              | Background job worker (agent execution)                     |
| `build:edge-worker`                                                   | Bundles the worker as the `tenderos-worker` Edge Function   |
| `lint`, `typecheck`, `format`, `format:check`                         | Code quality                                                |
| `test` / `test:unit`                                                  | Unit tests (business rules, state machine, permissions)     |
| `test:integration`                                                    | Against local Supabase: workflow, RLS, roles, failure paths |
| `test:e2e`                                                            | Playwright, against a production build plus a real worker   |
| `db:start`, `db:stop`, `db:reset`, `db:migrate`, `db:types`, `db:env` | Database                                                    |
| `ci`                                                                  | lint, typecheck, unit tests and build                       |

`test:integration` and `test:e2e` refuse to run against a non-local database.
For e2e, run `npm run build` first; if Playwright's bundled browser is not
installed, set `PLAYWRIGHT_CHROMIUM_PATH`. Set `E2E_SCREENSHOTS=<dir>` to keep
screenshots of each stage.

## Province discovery

Choose provinces on **Discover**. The Tender Scout reads every published
tender on National Treasury eTenders, keeps the ones in those provinces and
hands each to the Tender Director, who runs analysis, qualification,
compliance, proposal, pricing and QA without anyone pressing a button. Scans
repeat every morning. Fill in **Company** (CIPC, CSD, tax PIN, B-BBEE,
signatory) so compliance can pass; tenders stopped at compliance resume when
you save it. You approve each finished bid, then sign and deliver it: the
portal does not accept automated submissions and the declarations are yours
to sign.

## Company documents

Upload CIPC, CSD, tax status, B-BBEE, SBD forms and other returnables on
**Documents**. Files go to the private `company-documents` Storage bucket
under the organisation's folder; `register_company_document` records each one.
Owner and admin uploads count as verified; an operator's upload needs an owner
or admin to verify it. Compliance uses verified, in-date documents as evidence
on every tender, and the Submission Officer lists them in the bid pack with
download links. Verifying or adding a document re-checks bids stopped at
compliance. Bank letters, director IDs and proof of address are only visible to
the Document Manager agent.

## Hosted worker (Supabase Edge Function)

Supabase does not run long-lived processes, so on a hosted project the worker
runs as the `tenderos-worker` Edge Function, called every minute by pg_cron.
Each call processes ready jobs for about 45 seconds, so steps advance within a
minute rather than instantly.

1. `npm run build:edge-worker` writes `supabase/functions/worker/index.ts`.
2. Deploy it as `tenderos-worker` with JWT verification on
   (`supabase functions deploy`, or the dashboard).
3. Migration `20261010000008` generates the worker secret in Vault. Add the
   project URL and the legacy anon JWT to Vault, then schedule the job:

```sql
select vault.create_secret('https://<ref>.supabase.co', 'tenderos_project_url');
select vault.create_secret('<legacy anon JWT>', 'tenderos_function_jwt');
select private.schedule_edge_worker();
```

The function also requires the Vault-held secret in an `x-worker-secret`
header, so the public anon key alone cannot trigger it. Set
`SIMULATION_STEP_MS` or `RUN_BUDGET_MS` as function secrets to change pacing.

## Configuration

Copy `.env.example` to `.env.local`. It lists every variable with placeholders
only. Never commit real values.

## Documentation

- `AGENTS.md`: agent rules (hierarchy, permissions, handoffs, approvals, anti-hallucination)
- `docs/architecture.md`: system overview and file structure
- `docs/database.md`: schema, state machine, queue, RLS
- `docs/security.md`: security architecture
- `docs/roadmap.md`: phases and the milestone 1 definition
- `docs/local-development.md`: local setup, deployment, troubleshooting
- `docs/adr/`: architecture decisions
