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

Sign up, confirm your email (the message lands in the local mail catcher; see
`docs/local-development.md`), name your organisation, create a tender with "Simulation" ticked,
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
compliance, proposal, pricing and QA without anyone pressing a button (automatic
runs are off for a new organisation; switch them on in Discover). New
organisations are guided through sectors, provinces, CIDB grade and keywords
right after sign-up, and can skip that (`docs/auth.md`). Scans
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

**One click.** Build and load the helper once (`npm run build:extension`, then
**Load unpacked** on `extension/dist`; see `extension/README.md`). Owners, admins
and operators then open **Settings → Browser helper** and press **Connect
browser**: TenderOS creates the pairing code and hands it straight to the helper
in the same browser, so there is nothing to copy or paste. The code is never
shown, put in a URL or logged; it lasts 30 days, is stored only as a SHA-256 hash
on the server, and can be revoked on the same card. If no helper answers within
about a second and a half, the page shows how to install it. Pasting a code into
the helper still works as an advanced fallback.

On the tender page of an approved bid that is delivered through a web portal,
**Apply with TenderOS** asks the helper to open the portal in a new tab, fill the
company details and attach the approved bid pack documents (matching file inputs
are filled automatically; nothing is picked by hand). A review panel on the portal
page lists what was filled and attached and what is left for you (declarations,
price schedule, signatures, anything it is unsure of). The helper then reports the
host and counts to TenderOS, and the tender page shows "Prepared by TenderOS at
...". **You still check everything and press the portal's Submit yourself.**

How it stays safe:

- The helper fills a page only when its site (registrable domain) is the portal
  TenderOS named for the tender; on any other site it asks you to confirm, naming
  both hosts. Only https pages are filled (http only on localhost in a
  development build), only the top frame and same-origin frames, and the page
  must still be on that host when the fill starts.
- The production manifest has no wildcard or optional host permissions and no
  localhost. It can act by itself only on the TenderOS address it was built for
  and the portal hosts it was built with (`TENDEROS_PORTAL_HOSTS`, default the
  eTenders portal). Any other portal is filled from the toolbar button, on the
  page you are looking at.
- The helper reads `GET /api/autofill/profile`, `GET /api/autofill/documents/<id>`
  and `GET /api/autofill/tenders/<id>/apply-plan` with its pairing code, and
  reports with `POST /api/autofill/tenders/<id>/apply-report` (host and counts
  only; audit log and tender event). Director IDs, bank letters and proof of
  address only reach owners and admins, and only when they tick the option on
  the tender page; every file download is audited.

`TENDEROS_ORIGIN` sets the TenderOS address a build talks to (default
`https://tenderos-six.vercel.app`; `http://localhost:3000` makes a development
build). Publishing the helper in the Chrome Web Store is the later one-click
install route.

## Hosted worker (Supabase Edge Function)

Supabase does not run long-lived processes, so on a hosted project the worker
runs as the `tenderos-worker` Edge Function, called every minute by pg_cron.
Each call processes ready jobs for about 45 seconds, so steps advance within a
minute rather than instantly.

1. `npm run build:edge-worker` writes `supabase/functions/worker/index.ts`.
2. Deploy it as `tenderos-worker`:

   ```bash
   npx supabase link --project-ref <ref>
   npx supabase functions deploy tenderos-worker
   ```

   The code is in the folder `supabase/functions/worker`, and the cron job
   calls `/functions/v1/tenderos-worker`. The mapping that joins the two is the
   `[functions.tenderos-worker]` table in `supabase/config.toml` (entrypoint
   `./functions/worker/index.ts`, `verify_jwt = true`); without it Supabase
   would deploy the folder as `worker` and the cron job would call nothing. A
   unit test fails if the names or the entrypoint drift apart. Add
   `--use-api` when Docker is not running. Deploying from the dashboard works
   too, but the function must be named `tenderos-worker` and keep JWT
   verification on.

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
