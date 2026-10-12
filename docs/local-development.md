# Local development and deployment

## Local

```bash
npm install
npm run db:start     # Docker must be running
npm run db:env       # writes .env.local from `supabase status`
npm run dev
npm run worker       # second terminal
```

New accounts must confirm their email address. Locally the confirmation email
lands in the mail catcher (Mailpit): open the "Inbucket URL" from
`npx supabase status` (http://127.0.0.1:56324 with the default ports), or read
it from tests with `tests/e2e/helpers/mailbox.ts` (`MAILBOX_URL` overrides the
address). Auth settings are read when the stack starts, so after pulling a
change to `supabase/config.toml` (confirmations, redirect URLs) restart the
stack. How auth works and what a hosted project needs: `docs/auth.md`.

`npm run db:reset` recreates the database from migrations. After a schema
change, run `npm run db:migrate` and `npm run db:types`.

Without the worker, workflows start but no agent picks up work; the sidebar
shows "Agent worker offline".

Starting Supabase with fewer services is fine for development:

```bash
npx supabase start -x studio,imgproxy,edge-runtime,logflare,vector,supavisor,postgres-meta,mailpit
```

## Checks before calling a change done

```bash
npm run lint && npm run typecheck && npm run test:unit
npm run test:integration       # needs local Supabase
npm run build && npm run test:e2e
```

## AI (optional)

Agents run rules-only or simulated by default. To try the model-backed
executors on a real tender, set `AI_ENABLED=true`, `ANTHROPIC_API_KEY`, the
`AI_MODEL_*` and `AI_PRICE_*` variables from `.env.example`, and restart the
worker. Tender documents are not downloaded yet, so the Tender Analyst reports
that it had none to read. `npm run eval:live` scores a real model against the
labelled fixtures in `tests/eval` and does nothing without `ANTHROPIC_API_KEY`;
see `docs/ai-agents.md`. After changing the Anthropic SDK version, run
`npm run build:edge-worker` and commit the regenerated bundle.

## Deploying

1. Create a Supabase project. Apply migrations with
   `npx supabase link --project-ref <ref>` and `npx supabase db push`.
2. Configure Supabase Auth with the checklist in `docs/auth.md` (site URL and
   redirect URLs, email confirmation, SMTP, CAPTCHA, templates).
3. Deploy the web app (for example to Vercel) with:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`, `AUTH_RATE_LIMIT_SECRET`,
   `TRUSTED_IP_HEADER` (and `CAPTCHA_MODE` with the Turnstile keys).
4. Run the worker as a long-lived process (a container on Fly.io, Railway,
   Render or similar) with `DATABASE_URL` (session pooler or direct
   connection; `LISTEN` does not work through a transaction pooler),
   `WORKER_CONCURRENCY`, `SIMULATION_STEP_MS`, `LOG_LEVEL`.
5. Run more than one worker for availability; `SKIP LOCKED` keeps them from
   taking the same job.

## Troubleshooting

- **Agents never start**: check the worker is running and the sidebar shows
  it online; check the kill switch and whether the agent is paused.
- **Workflow will not start**: only `DISCOVERED` tenders flagged simulation
  can start while simulation mode is on.
- **Integration tests refuse to run**: they only run against a local database.
