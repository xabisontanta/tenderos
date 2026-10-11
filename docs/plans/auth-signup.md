# Plan: sign-up and authentication (approved 2026-10-11)

Source: ECC `planner` run on the `production-readiness` branch, merged with
the product owner's answers. Findings behind it are in
`docs/production-readiness.md`.

## Decisions (product owner, 2026-10-11)

1. **One organisation per user.** Keep it; enforce it in the database (S5).
2. **AI provider: Anthropic.** `.env.example` must name Anthropic, not OpenAI.
3. **Payment gateway: out of scope for now.** No billing work.
4. **Legal text:** drafts only, prepared by Claude, reviewed by an attorney
   before launch (`docs/legal/popia-overview.md`). Placeholder text may ship
   to staging; production needs attorney-reviewed text and a named owner.
5. **Final bid submission stays a person's click.** Agents prepare, fill and
   attach; the member reviews and submits. This is existing policy
   (`AGENTS.md` section 8) and the eTenders portal rejects automated
   submissions.

## Facts from the code that shape the work

- `hit_rate_limit_key` (migration 015) is service-role only. Its key must
  match `^[a-z][a-z0-9_]{2,30}:[A-Za-z0-9-]{1,64}$` and windows cap at 3600 s.
  A 64-char hex HMAC fits (`auth_ip:<hex64>`). Nothing cleans
  `private.rate_limits`.
- `company_profiles` already has `sectors text[]` (free text, exact
  case-insensitive match in qualification), `provinces text[]`
  (`valid_provinces`) and `cidb_grade text` (`^[1-9][A-Z]{1,3}$`). No
  `keywords` column.
- Some privileged paths run as the service role, where a database aal2 check
  never fires: `sendBidEmail`, `registerDocument`, `/api/autofill/*`.
- Migrations 014 and 016 patch function bodies by text replacement;
  `tests/integration/hardening.test.ts` asserts the rate-limit lines survive.
- `tests/e2e/milestone.spec.ts` expects sign-up to land on `/onboarding`.
- Migrations are stored LF but checked out CRLF on Windows (`autocrlf`);
  `.gitattributes` now forces LF.

## Slices (dependency order; migration numbers are reserved)

**S1. Auth links from `APP_URL`** (S, no migration). `lib/auth/urls.ts`
`authRedirectUrl(path)`; `features/auth/actions.ts:51,73` and
`app/auth/callback/route.ts` stop using the `Origin` header or request origin;
no production default for `APP_URL`. Test first: forged Origin, trailing
slash, `next` through `safeRedirectPath`.

**S2. App-level auth rate limits and CAPTCHA hook** (M, `017_auth_abuse_controls`).
`private.sweep_rate_limits()` deletes rows older than a day, scheduled with
pg_cron behind an exists-guard. `lib/auth/rate-limit.ts` (`clientIp()` from a
configured trusted header `TRUSTED_IP_HEADER`; keys are
`HMAC-SHA256(AUTH_RATE_LIMIT_SECRET, value)` hex; calls
`hit_rate_limit_key` via the admin client; fail closed with 503),
`lib/auth/captcha.ts` (`verifyCaptcha`, no-op when `TURNSTILE_SECRET_KEY`
unset), `features/auth/turnstile.tsx`, CSP additions only when configured,
`CAPTCHA_MODE=off|app|supabase`. Limits: sign-in 20/5 min per IP and 10/15 min
per email; sign-up 5/h and 3/h; reset 5/h and 3/h (generic message when
limited). IP and email are personal data: store only HMACs. Prefer escalating
to CAPTCHA over hard-blocking an email.

**S3. Email confirmation and enumeration-safe sign-up** (M, no migration).
`config.toml`: `enable_confirmations=true`, `max_frequency="60s"`, SMTP block,
local mail catcher port. Sign-up always returns one message; rate-limited
`resendConfirmation`; `app/auth/confirm/route.ts` using `token_hash` +
`verifyOtp` if PKCE `exchangeCodeForSession` fails across browsers. E2E:
`tests/e2e/helpers/mailbox.ts`; `milestone.spec.ts` confirms via the
mailbox. Needs S1.

**S4. Terms and privacy consent** (M, `018_legal_consent`). `legal_documents`
(kind, version, is_current) and `legal_acceptances` (user_id, kind, version,
accepted_at default now(), ip_hmac), RLS select-own, no direct writes.
`handle_new_user` re-created explicitly: records acceptance only when the
metadata versions equal the current ones, never raises. `accept_legal` RPC for
re-acceptance, rate-limited. `lib/legal/versions.ts`, checkbox in
`auth-form.tsx`, public `/terms` and `/privacy` pages (placeholder text from
`docs/legal`), `/legal/accept` page, middleware public paths.

**S5. One organisation per user; bootstrap race** (S, `019_single_org_membership`).
Pre-check raising on users with more than one membership; unique index on
`organisation_members(user_id)`; re-create `bootstrap_organisation` keeping
the advisory lock and signature; deterministic `lib/data/context.ts`.

**S6. Guided onboarding** (M, `020_onboarding_keywords`). `company_profiles.keywords
text[]` with a validator (at most 50, 2 to 60 chars each);
`system_settings.onboarding_completed_at`. Wizard at
`app/onboarding/profile`: sectors, provinces (also `set_watched_provinces`,
auto-run off by default), CIDB grade, keywords. Skippable.

**S7. Role change, member removal, last-owner guard** (M, `021_member_management`).
`change_member_role`, `remove_member` (owner/admin; only owners grant or
revoke owner; row-locked last-owner guard; removal revokes autofill tokens
and email accounts and writes audit); trigger preventing zero owners.

**S8. Invitations** (L, `022_invitations`). `organisation_invitations`
(`token_hash` hex64 never granted to clients, email, role, expiry 7 days,
accepted/revoked); partial unique index on pending (org, lower(email));
`create_invitation` (returns plaintext once), `revoke_invitation`,
`accept_invitation(p_token)` (caller's confirmed JWT email must match; same
advisory lock as bootstrap; unique index enforces one organisation). Token
travels in an httpOnly cookie, stripped from the URL. Needs S3, S5, S7 and
the nodemailer upgrade.

**S9. TOTP enrolment and challenge** (M, no migration). `[auth.mfa.totp]`
enabled; `/mfa` challenge page; security card in settings; middleware redirect
when next level is aal2 and current is aal1. Test TOTP via a dev dependency.

**S10. aal2 enforcement** (L, `023_require_aal2`). `system_settings.require_mfa`;
`private.require_aal2(p_org)` (errcode `P0403`, no-op without `auth.uid()`);
`set_require_mfa` (owner, must be aal2 to enable); explicit `create or
replace` of each privileged RPC (take bodies from `pg_get_functiondef`, keep
`hit_rate_limit` lines) plus app-level `requireAal2` on the service-role
paths. Catalogue test asserts each listed function calls `require_aal2(`.
Needs S9 and S7.

## Must not merge alone

S3 needs S1. S8 needs S3, S5, S7 and the nodemailer upgrade. S10 needs S9 and
S7. S4 needs legal text before production. Update `milestone.spec.ts` in the
same change as S3, S4 and S6.

## Risks

App-level limiter does not cover direct `/auth/v1` calls with the anon key
(enforce CAPTCHA in Supabase as well); re-creating about 17 RPCs risks
dropping earlier patches; a lost TOTP device locks an owner out (needs a
support runbook); consent rows and invitations reference `auth.users`, which
interacts with POPIA erasure; a per-email limit can lock out a known victim.

## Assumptions to verify before relying on them

Supabase fake-user response on existing email when confirmations are on;
PKCE cross-browser failure; MFA availability on the hosted plan; no built-in
recovery codes; `aal` claim refresh after verify; Cloudflare siteverify shape
and token single-use; Vercel client-IP header semantics. Verify each against
official docs or against the local stack, and record the result.
