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
