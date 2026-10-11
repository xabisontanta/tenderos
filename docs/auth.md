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

### Sign-up and email confirmation

Email confirmation is on (`enable_confirmations = true` in `supabase/config.toml`;
hosted projects set it in the dashboard). Nobody can sign in with an address
they have not proved they own, and an address that is already registered looks
exactly like a new one:

- `signUp` (`features/auth/actions.ts`) returns one answer, "Check your email
  to confirm your account. If you already have an account, sign in or reset your
  password instead.", for a new address, for an address that already has an
  account (Supabase returns an obfuscated user, or `user_already_exists`), and
  for an address that was emailed in the last 60 seconds
  (`over_email_send_rate_limit`). A unit test checks the returned states are equal.
- `resendConfirmation` sends the confirmation again, limited per address and per
  email (`auth.resend`), behind the CAPTCHA when one is on. It answers the same
  whatever Supabase says. The sign-up and sign-in forms offer it.
- Signing in with an unconfirmed address says so and offers the resend.
  Supabase reports this only after the password was right, so it tells a stranger nothing.
- Auth sends at most one confirmation per address every 60 seconds
  (`max_frequency`).
- A session comes back from `signUp` only when the server confirmed the address
  itself (a local stack started without confirmations); the action then goes
  straight to onboarding.

#### The two link flavours

| Route            | Link                                                                                       | Works in another browser?                                     |
| ---------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `/auth/callback` | Supabase's own verify link, which comes back with a PKCE `code` (`{{ .ConfirmationURL }}`) | **No**: the verifier is stored only in the browser that asked |
| `/auth/confirm`  | A link to the app carrying `token_hash` and `type`, verified with `verifyOtp`              | Yes                                                           |

People open confirmation emails on their phone as often as not, so the email
templates must use the `token_hash` form. Template contract (for whoever builds
`supabase/templates`):

- Confirm signup: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/onboarding`
- Reset password: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password`
- `type` must be one of `email`, `signup`, `recovery`, `email_change`; `next` is
  optional, same-site paths only (anything else becomes `/`). Hash up to 512 characters.
- `{{ .SiteURL }}` must equal `APP_URL` (set Site URL accordingly).

An invalid, expired or already used link sends the visitor to
`/login?error=link_invalid`, which explains what to do. Until the templates are
switched, the default `{{ .ConfirmationURL }}` links keep working through
`/auth/callback`, in the browser that signed up.

Known limitation: a mail scanner that opens links before the person does (some
corporate gateways) uses up a one-time link. The person then sees the "expired"
message and can ask for a new one. If this shows up in support, put a confirm
button between the link and `verifyOtp` (a page that POSTs the same fields).

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

- [ ] Authentication > Sign In / Providers > Email: **Confirm email** on;
      minimum password length 12, letters and digits required (the app checks the same).
- [ ] Authentication > URL Configuration: Site URL is `APP_URL`; redirect URLs
      include `<APP_URL>/auth/callback` and `<APP_URL>/auth/confirm`.
- [ ] Authentication > Emails > SMTP Settings: a real SMTP server (provider,
      verified sending domain with SPF, DKIM and DMARC; `MAIL_FROM` as sender).
      The built-in hosted mailer allows only a few emails an hour and is not for customers.
- [ ] Authentication > Rate Limits: emails sent per hour is above your
      expected sign-ups plus resets (the config.toml value is 100).
- [ ] Authentication > Emails > Templates: the confirm-signup and reset
      templates link to `/auth/confirm` with `token_hash` (see above).
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

| Assumption                                                                               | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Source                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Vercel overwrites `X-Forwarded-For` so a client cannot forge its address                 | **Verified.** Vercel documents that it overwrites `X-Forwarded-For` and does not forward external IPs, to prevent spoofing. `x-real-ip` equals it. `x-vercel-forwarded-for` equals it too but is not overwritten when another proxy sits in front of Vercel. Only Enterprise trusted proxies may pass a custom value.                                                                                                                                                                                                                                                                                                                                                                                                                      | vercel.com/docs/headers/request-headers                                                    |
| Turnstile `siteverify` request and response shape                                        | **Verified.** `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret` and `response` (form or JSON; `remoteip` and `idempotency_key` optional). Response has `success`, `challenge_ts`, `hostname`, `error-codes`, `action`, `cdata`. A token is valid 300 seconds, is single-use (a replay fails with `timeout-or-duplicate`) and is at most 2048 characters. Cloudflare's published test keys return `action: "test"`, so the action is not checked.                                                                                                                                                                                                                                                              | developers.cloudflare.com/turnstile/get-started/server-side-validation, /reference/testing |
| Turnstile with a nonce + `strict-dynamic` CSP                                            | **Verified from docs, not run in a browser.** Cloudflare lists `challenges.cloudflare.com` for script-src and frame-src, says Turnstile propagates the nonce and works with `strict-dynamic`, and says connections to that origin must be allowed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | developers.cloudflare.com/turnstile/reference/content-security-policy                      |
| Sign-up for an existing address, with confirmations on, returns a fake user and no error | **UNVERIFIED by experiment.** The supabase-js reference only warns that "you may get back an error message that attempts to hide this information"; secondary sources describe an obfuscated user (empty `identities`, no session) with confirmations on and "User already registered" with them off, and say an unconfirmed address is re-sent the email. The local stack in use runs with confirmations off and its Auth container could not be recreated, so the confirmations-on path was never exercised. The app does not depend on which one Supabase picks: success with no session, `user_already_exists` and `over_email_send_rate_limit` all produce the same reply (unit-tested). Re-check on a staging project before launch. | supabase.com/docs/reference/javascript/auth-signup (partial)                               |
| Unconfirmed address, resend, and `token_hash` links                                      | **Verified on the local stack** (`tests/integration/auth-confirmation.test.ts`): sign-in fails with `email_not_confirmed`; the resent email reaches the mail catcher with a verify link that confirms the address; a `token_hash` from `generateLink` verifies once in a client with no PKCE state, and a forged hash is refused. Auth treats magic-link and recovery hashes as interchangeable.                                                                                                                                                                                                                                                                                                                                           | local run                                                                                  |
| PKCE confirmation links fail when opened in another browser                              | **Verified.** The code verifier is stored only in the browser that started the flow, so the code exchange must happen there. The auth code lives 5 minutes and can be exchanged once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | supabase.com/docs/guides/auth/sessions/pkce-flow                                           |
