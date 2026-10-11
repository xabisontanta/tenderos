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

### Abuse controls: rate limits and CAPTCHA

Sign-in, sign-up, password reset and resending a confirmation email are
unauthenticated, so they cannot use the per-user `hit_rate_limit`. They go
through `guardAuthAttempt` (`features/auth/guard.ts`) after input validation
and before Supabase Auth is called:

1. `limitAuthAttempt` (`lib/auth/rate-limit.ts`) counts the attempt against
   the visitor's address and the email with `hit_rate_limit_key` (service role
   only). Fixed windows:

   | Action  | Per address      | Per email         |
   | ------- | ---------------- | ----------------- |
   | sign-in | 20 per 5 minutes | 10 per 15 minutes |
   | sign-up | 5 per hour       | 3 per hour        |
   | reset   | 5 per hour       | 3 per hour        |
   | resend  | 5 per hour       | 3 per hour        |

2. **Personal data.** Addresses and emails are never stored. The subject is
   `HMAC-SHA256(AUTH_RATE_LIMIT_SECRET, "ip:<address>")` or `"email:<email>"`
   in hex, giving keys such as `auth_ip:<64 hex>:auth.signin`. IPv6 addresses
   are grouped by /64. `private.sweep_rate_limits()` (pg_cron, hourly) deletes
   rows whose window ended more than a day ago.
3. **Which address.** Only the header named in `TRUSTED_IP_HEADER` is read.
   `X-Forwarded-For`, `X-Real-IP` and the rest are ignored unless named,
   because a visitor can send them. If the header holds a list, the rightmost
   entry is used (the one our own edge added). With no header (local
   development) only the per-email limits apply, and a warning is logged.
4. **Fail closed.** If the limiter cannot answer (database error, invalid
   configuration) the attempt is refused with "temporarily unavailable"; it is
   not waved through. Server actions cannot set an HTTP status, so this shows
   as a form error rather than a 503.
5. **CAPTCHA** (`CAPTCHA_MODE`, Cloudflare Turnstile):
   - `off` (default): none. The sign-in email limit then blocks, so a known
     victim's account can be locked out for the window. Turn CAPTCHA on to avoid it.
   - `app`: sign-up, reset and resend always need a valid token, verified
     against Cloudflare's `siteverify` (`lib/auth/captcha.ts`). Sign-in needs
     one only after the email limit trips: it escalates to a CAPTCHA instead of
     blocking the email. The visitor's address is not sent to Cloudflare.
   - `supabase`: the token is passed to Supabase Auth as `captchaToken` and
     Supabase verifies it (turn on CAPTCHA protection in the dashboard with
     the same Turnstile secret). Every call needs a token.

   The address limit is never escalated. The widget (`features/auth/turnstile.tsx`)
   renders on the sign-in, sign-up and reset forms whenever CAPTCHA is on, and
   the CSP allows `challenges.cloudflare.com` for scripts, frames and
   connections only in that case. A token works once, so the widget fetches a
   fresh one after every submit.

The app-level limiter does **not** cover someone who calls
`<supabase-url>/auth/v1/*` directly with the public anon key. Cover that gap
with Supabase's own settings (the checklist below): CAPTCHA protection, email
confirmation, and the per-IP `sign_in_sign_ups` limit.

### Forms

Auth forms return field errors and the submitted values (never the password),
so a failed submit keeps what was typed, marks the field `aria-invalid`,
links the message with `aria-describedby` and moves focus to the first
problem (`features/auth/form-parts.tsx`).

## Environment variables

See `.env.example` for the full list with placeholders. Auth-related:

| Variable                 | Required                     | Purpose                                                                                |
| ------------------------ | ---------------------------- | -------------------------------------------------------------------------------------- |
| `APP_URL`                | in production                | Public origin used for every emailed or redirected auth link                           |
| `AUTH_RATE_LIMIT_SECRET` | in production (32+ chars)    | Key for the HMACs that replace addresses and emails in rate-limit keys                 |
| `TRUSTED_IP_HEADER`      | in production                | Header the platform sets to the visitor's address (`x-vercel-forwarded-for` on Vercel) |
| `CAPTCHA_MODE`           | no (`off`)                   | `off`, `app` or `supabase`                                                             |
| `TURNSTILE_SITE_KEY`     | when CAPTCHA_MODE is not off | Public key for the widget                                                              |
| `TURNSTILE_SECRET_KEY`   | when CAPTCHA_MODE is `app`   | Secret for `siteverify`; keep it server-side                                           |

`authEnv()` in `lib/env.ts` validates these. A bad value makes auth attempts
fail closed and logs the variable name (never a value).

## Hosted Supabase checklist

Local settings live in `supabase/config.toml`; a hosted project does not read
that file, so each item below is set in the dashboard (or pushed with
`supabase config push`).

- [ ] Authentication > URL Configuration: Site URL is `APP_URL`; redirect URLs
      include `<APP_URL>/auth/callback`.
- [ ] Authentication > Attack Protection: CAPTCHA protection on with Cloudflare
      Turnstile (needed for `CAPTCHA_MODE=supabase`; recommended either way, since
      it also covers direct calls to the Auth API).
- [ ] Authentication > Rate Limits: leave the per-IP limits on. Because the app
      calls Auth from its own server, Supabase sees one address for every
      visitor, so these limits protect the shared quota, not individuals;
      the per-visitor limits are the app's.

## Assumptions checked against official documentation

Checked on 2026-10-11 by reading the vendors' documentation (not by running a
hosted project).

| Assumption                                                               | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Source                                                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Vercel overwrites `X-Forwarded-For` so a client cannot forge its address | **Verified.** Vercel documents that it overwrites `X-Forwarded-For` and does not forward external IPs, to prevent spoofing. `x-real-ip` equals it. `x-vercel-forwarded-for` equals it too but is not overwritten when another proxy sits in front of Vercel. Only Enterprise trusted proxies may pass a custom value.                                                                                                                                                         | vercel.com/docs/headers/request-headers                                                    |
| Turnstile `siteverify` request and response shape                        | **Verified.** `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret` and `response` (form or JSON; `remoteip` and `idempotency_key` optional). Response has `success`, `challenge_ts`, `hostname`, `error-codes`, `action`, `cdata`. A token is valid 300 seconds, is single-use (a replay fails with `timeout-or-duplicate`) and is at most 2048 characters. Cloudflare's published test keys return `action: "test"`, so the action is not checked. | developers.cloudflare.com/turnstile/get-started/server-side-validation, /reference/testing |
| Turnstile with a nonce + `strict-dynamic` CSP                            | **Verified from docs, not run in a browser.** Cloudflare lists `challenges.cloudflare.com` for script-src and frame-src, says Turnstile propagates the nonce and works with `strict-dynamic`, and says connections to that origin must be allowed.                                                                                                                                                                                                                            | developers.cloudflare.com/turnstile/reference/content-security-policy                      |
| PKCE confirmation links fail when opened in another browser              | **Verified.** The code verifier is stored only in the browser that started the flow, so the code exchange must happen there. The auth code lives 5 minutes and can be exchanged once.                                                                                                                                                                                                                                                                                         | supabase.com/docs/guides/auth/sessions/pkce-flow                                           |
