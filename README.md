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
repeat every morning, and tenders already on file are updated when eTenders
changes them (a moved closing date is flagged). Fill in **Company** and upload
your CIPC, CSD, tax compliance and signed SBD documents on **Documents**:
compliance only passes on uploaded, verified, in-date documents, never on
typed-in numbers alone. Tenders stopped at compliance resume when you add or
verify a document. You approve each finished bid, then sign and deliver it:
the portal does not accept automated submissions and the declarations are
yours to sign. If you send a bid back, or QA fails it, **Prepare bid again**
re-checks compliance and runs proposal, pricing and QA once more.

## Company documents

Upload CIPC, CSD, tax status, B-BBEE, SBD forms and other returnables on
**Documents**. Files go to the private `company-documents` Storage bucket
under the organisation's folder; `register_company_document` records each one.
Owner and admin uploads count as verified; an operator's upload needs an owner
or admin to verify it. Compliance uses verified, in-date documents as evidence
on every tender, and the Submission Officer lists them in the bid pack.
Download links are created when you click and last 60 seconds; each download
is audited. Verifying or adding a document re-checks bids stopped at
compliance. Bank letters, director IDs and proof of address can only be opened by owners
and admins, and among the agents only the Document Manager sees them.

## Sending bids by email

Owners and admins connect the mailbox they send from on **Settings**: a Gmail
account (Google sign-in, send-only permission) or a mailbox on the company's
own domain (SMTP on port 465, 587 or 2525). TenderOS signs in once to check
the details, then keeps the password or Google token encrypted in Supabase
Vault; browsers never receive it and each mailbox can only be used by the
person who connected it. SMTP hosts must resolve to public addresses.

When an approved bid has to be emailed, the tender's submission tab shows a
pre-filled message to the address in the tender notice, with your verified
documents ready to attach (18 MB in total at most). Nothing is sent until you
press Send and confirm. The email is logged and the bid is recorded as
delivered. For hand or portal delivery, **Record as delivered** closes the
bid with your reference number.

Gmail needs `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` from a
Google Cloud OAuth client with the redirect URI
`<APP_URL>/api/email/google/callback`. Until Google verifies the app for the
`gmail.send` scope, only test users you add in Google Cloud can connect.

## Filling portal forms (browser helper)

Most portals take bids through web forms that ask for the same company facts
every time. The browser helper in `extension/` (Chrome and Edge, loaded
unpacked) fills those forms in your own browser: company name, registration,
CSD, VAT and tax PIN, B-BBEE level, CIDB grade, addresses and contacts, the
tender number, and your verified, in-date documents as attachments. **It
fills; you submit.** It never presses submit, never ticks declarations, never
enters prices and never signs, and anything it is unsure of or TenderOS does
not hold is left empty and listed for you.

Owners, admins and operators pair it on **Settings → Browser helper** with a
pairing code that is shown once, lasts 30 days and can be revoked there. Only
its SHA-256 hash is stored. The helper reads `GET /api/autofill/profile` and
`GET /api/autofill/documents/<id>` with that code; director IDs, bank letters
and proof of address only reach owners and admins, and every file download is
audited. See `extension/README.md` to install and use it.

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
- `docs/production-readiness.md`: audit findings, launch blockers and the phased plan to production
- `docs/local-development.md`: local setup, deployment, troubleshooting
- `docs/adr/`: architecture decisions
