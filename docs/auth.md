# Sign-up and authentication

How accounts are created and protected, which settings must be right on the
hosted Supabase project, and what was checked against official documentation.
Plan and slice order: `docs/plans/auth-signup.md`. Threat model and the rest of
the security design: `docs/security.md`.

## How it works

TenderOS uses Supabase Auth (email and password). Every auth call is made from
the Next.js server (server actions and route handlers), so Supabase sees the
server's address, not the visitor's. That is why abuse limits live in the app
as well.

### Links in emails come from APP_URL

Every link that goes into an auth email (`emailRedirectTo` for sign-up,
`redirectTo` for password reset) or into a redirect is built by
`authRedirectUrl()` in `lib/auth/urls.ts` from `APP_URL`. Request headers
(`Origin`, `Host`, `X-Forwarded-*`) are chosen by the caller and are never
used, so a forged header cannot send a victim a reset link that points at
another site.

- `APP_URL` is the site origin only (`https://app.example.com`), no path.
- Outside production it defaults to `http://localhost:3000`. In production it
  is required, must be `https` (a local server such as `http://127.0.0.1:3100`
  is allowed so end-to-end runs against `next start` work) and the app fails
  loudly when it is missing.
- `next` values go through `safeRedirectPath`: only same-site paths survive.
- `/auth/callback` redirects with `APP_URL` too, not with the request URL,
  because behind a proxy the request URL can carry an internal origin and the
  browser would land on a host that does not hold its cookies.

## Environment variables

See `.env.example` for the full list with placeholders. Auth-related:

| Variable  | Required      | Purpose                                                      |
| --------- | ------------- | ------------------------------------------------------------ |
| `APP_URL` | in production | Public origin used for every emailed or redirected auth link |

## Hosted Supabase checklist

Local settings live in `supabase/config.toml`; a hosted project does not read
that file, so each item below is set in the dashboard (or pushed with
`supabase config push`).

- [ ] Authentication > URL Configuration: Site URL is `APP_URL`; redirect URLs
      include `<APP_URL>/auth/callback`.

## Assumptions checked against official documentation

Checked on 2026-10-11 by reading the vendors' documentation (not by running a
hosted project).

| Assumption                                                               | Result                                                                                                                                                                                                                                                                                                                | Source                                           |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Vercel overwrites `X-Forwarded-For` so a client cannot forge its address | **Verified.** Vercel documents that it overwrites `X-Forwarded-For` and does not forward external IPs, to prevent spoofing. `x-real-ip` equals it. `x-vercel-forwarded-for` equals it too but is not overwritten when another proxy sits in front of Vercel. Only Enterprise trusted proxies may pass a custom value. | vercel.com/docs/headers/request-headers          |
| PKCE confirmation links fail when opened in another browser              | **Verified.** The code verifier is stored only in the browser that started the flow, so the code exchange must happen there. The auth code lives 5 minutes and can be exchanged once.                                                                                                                                 | supabase.com/docs/guides/auth/sessions/pkce-flow |
