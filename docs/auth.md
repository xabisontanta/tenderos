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

### Terms and privacy consent

Creating an account needs the "I agree to the Terms of Service and have read the
Privacy Notice" box. The sign-up sends the versions now in force
(`lib/legal/versions.ts`) in the user metadata, together with an HMAC of the
visitor's address (`consent_ip_hmac`, under `AUTH_RATE_LIMIT_SECRET` in its own
namespace; never the address). The `private.handle_new_user` trigger records one
row per document in `public.legal_acceptances` (user, kind, version, time, hash)
**only if** the metadata names the versions marked `is_current` in
`public.legal_documents`; anything else is ignored, and a failure there is a
warning that never blocks the account.

- A user with a missing or out-of-date acceptance is sent to `/legal/accept`
  by `requireContext` (every signed-in page) and the onboarding page. Publishing
  a new version therefore asks everyone again on their next visit. Browsers
  cannot write acceptances; `accept_legal` (rate limited, current versions only)
  is the only path besides the trigger.
- `/terms` and `/privacy` are public. Their text is a **draft placeholder**,
  written from the headings of `docs/legal/popia-overview.md`, with a visible
  notice that it is unreviewed and not legal advice. Staging may show it;
  production needs attorney-reviewed text and a named owner (plan decision 4).
- To publish a new version: a migration that inserts the `legal_documents` row and
  flips `is_current`, plus the new value in `lib/legal/versions.ts`. The legal
  integration test fails if the two disagree.
- Consent records are deleted with the account (`on delete cascade`). Whether
  proof of consent must outlive the account is an open point for the attorney.

### One organisation per user

A person belongs to at most one organisation (product decision; consultants
serving several clients are not supported yet). A unique index on
`organisation_members(user_id)` enforces it, whichever code path adds a
membership. `bootstrap_organisation` still takes a per-user advisory lock, so
simultaneous sign-ups queue instead of failing noisily; a lost race rolls the
whole call back (no stray organisation or agents) and returns the same
"User already belongs to an organisation" error. `requireContext` reads the single
membership and reports a failed lookup as an error instead of sending the person
to onboarding to create another organisation.

The migration (019) refuses to run while any user has several memberships; it does not
pick one. If that ever fires on a real database, decide with the customer which
organisation each listed user stays in, remove the other memberships, and run it again.

### Teams and invitations

The product is sold to companies and to the accountants, auditors and tender consultants who work inside a client's
account. A person belongs to one organisation, so they **join the client's organisation as a member**; an auditor or
accountant gets the read-only **viewer** role. Roles: Owner, Admin, Operator, Viewer (what each can do is in
`docs/security.md`, and in plain words in Settings, Team).

**Managing members** (migration 060). Settings, Team lists the members with a role menu and a remove button for owners
and admins (`change_member_role`, `remove_member`, `list_members`). Email addresses are shown to owners and admins only.
An organisation always keeps an owner; ownership is transferred by making the new person an owner and stepping down.
Every member can leave the organisation (that is how someone invited elsewhere gets free). Details and the rules
for who may do what: `docs/security.md`, "Team management".

**Invitations** (migration 061).

1. An owner or admin enters an address and a role in Settings, Team. Owners invite admins, operators and viewers; admins
   invite operators and viewers; nobody invites an owner. `create_invitation` makes a token (`tinv_` and 64 hex digits),
   stores only its SHA-256 hash, returns the token **once**, and expires the invitation after 7 days. Limits: 20 invitations an hour per
   person, 50 pending per organisation, and any one address receives at most 5 a day from anywhere. A pending invitation
   to the same address (any letter case) is refused; an expired one is retired when a new one is issued.
2. The app emails it (`docs/email.md`, "Platform mailer") with the branded `teamInvitation` email. If the email cannot be
   sent, the invitation still exists and the inviter is shown the link once. Resend rotates the token and renews the
   week (the old link stops working); Withdraw ends it.
3. The link is `${APP_URL}/invite/<token>`. `app/(auth)/invite/[token]/route.ts` puts the token in an **httpOnly,
   SameSite=Lax cookie** (`tos_invite`, two hours, Secure under https) and redirects to `/invite`, so the token is not in
   the address the visitor keeps. The response is not cached and sends no Referer. The plan named
   `app/invite/[token]/page.tsx`; a page cannot set a cookie, so a route handler does it and the page is `/invite`.
4. `/invite` shows the organisation, the role and the invited address (from `invitation_preview`, service role only).
   The address is shown, **not trusted**. It never says whether the address has an account: "Create an account" and
   "Sign in" are always both offered. Someone already signed in without an organisation goes on to `/onboarding`.
5. `/onboarding` offers **Join <organisation>** instead of "create an organisation" while the cookie holds a live
   invitation, and "Create one" stays available as a choice (`?own=1`). `accept_invitation` requires the caller's
   **confirmed** address in `auth.users` and the address claim in their session token to both equal the invited one, takes the same
   per-user advisory lock as `bootstrap_organisation`, and relies on the unique index for one organisation per user:
   someone who already belongs elsewhere is told to leave first (Settings, Team, Leave). A wrong address is told "sent to a different
   email address" without naming it. Opening the link again after joining is harmless.

What was **not** done on purpose: the token never appears in logs (the log redactor knows the word `token`, and the email
renderer's error text, which quotes the link, is not logged); a used, revoked, expired or unknown token is refused with
one message (except "expired", which only a token holder can see). Rate limiting acceptance: a refused call rolls its
own counter back, so the database counts only calls that succeed; the server action counts every attempt first
(20 an hour). Tokens carry 256 bits, so guessing one is not a practical attack.

**Personal data.** An invitation holds the invitee's address. It is deleted with the account it was addressed to (a
trigger on `auth.users`, which also covers `erase_user`), purged 30 days after it was accepted, withdrawn or expired
(`private.purge_invitations`, pg_cron `tenderos-purge-invitations`, daily 03:40 UTC), removed with the organisation,
and included in both exports (`invitations` in the organisation's export, `invitations_received` and `invitations_sent`
in a person's), never with the token hash. The audit rows (`invitation.created`, `.resent`, `.revoked`, `.accepted`)
carry the invitation id and role, not the address.

**Known limitation.** Someone who already created their own (sole-owner) organisation and is then invited elsewhere
cannot leave it (an organisation must keep an owner) and so cannot accept until that organisation is erased or given to
another owner. Support handles it with the erasure runbook.

### Guided onboarding

After the organisation is created (`/onboarding`), owners and admins land on
`/onboarding/profile`: four optional questions that tell the Tender Scout where to
look.

| Question                              | Stored in                                                                                                         | Rule                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Sectors (free text, with suggestions) | `company_profiles.sectors`                                                                                        | up to 30, 2 to 120 characters each                       |
| Provinces                             | `company_profiles.provinces` and the Tender Scout's watched provinces (`set_watched_provinces`, **auto-run off**) | the provinces the scout can watch                        |
| CIDB grade                            | `company_profiles.cidb_grade`                                                                                     | `^[1-9][A-Z]{1,3}$`, e.g. `5CE`                          |
| Keywords                              | `company_profiles.keywords` (migration 020)                                                                       | up to 50, 2 to 60 characters each, no control characters |

- One zod definition (`features/company/schema.ts`) validates these on the wizard and on the
  Company page, and migrations 009 and 020 repeat the rules as constraints.
- **Skippable.** "Skip for now" saves nothing but the fact that the wizard was seen
  (`system_settings.onboarding_completed_at`, set by `complete_onboarding`, owners and
  admins, rate limited). The account then works as it does today: no provinces watched, so
  nothing is scanned until someone picks provinces on Discover. Until the wizard is finished or
  skipped, the dashboard shows a "Finish setting up" prompt for owners and admins. "Save and
  finish" writes only what was filled in, so blanks never erase what the Company page holds.
- **Automatic workflows are off for new organisations** (migration 020 changes the column
  default from on to off; existing organisations keep their setting). Previously a skipped wizard
  followed by choosing provinces left the scout starting bids on up to 25 tenders per scan
  without anyone asking. The wizard saves provinces with auto-run explicitly off too.
- The wizard keeps what was typed after a problem, moves to the step with the problem and focuses
  the field; steps have headings that take focus, and added or removed entries are announced.

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

### Multi-factor authentication (authenticator app, TOTP)

Anyone can add an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, a password manager) in
Settings, Security. `supabase/config.toml` switches it on (`[auth.mfa.totp] enroll_enabled` and `verify_enabled`); a hosted
project needs the same switches in the dashboard (Authentication, multi-factor settings; the exact page is **UNVERIFIED**).

- **Setting up** (`features/security`). "Start" calls `mfa.enroll({ factorType: "totp", friendlyName, issuer: "TenderOS" })` from a server
  action. The QR code (an SVG data URL, drawn only if it has that shape) and the secret go to the page for this one setup and are never
  stored or logged; a setup that was started and never finished is removed the next time one starts, so its name is free. The first six-digit
  code switches the factor on (`mfa.challenge` then `mfa.verify`), and that session becomes aal2. Several authenticators are allowed, and
  the screen tells people to add a second one.
- **Signing in.** A password gives aal1. `signIn` asks `mfa.getAuthenticatorAssuranceLevel()` and, when the current level is `aal1`
  and the next is `aal2`, goes to `/mfa?next=<where they were headed>` (only same-site paths survive `safeRedirectPath`). The
  middleware does the same on every page for a session that got there another way (an emailed confirmation link, a restored
  session), so the check cannot be skipped by typing an address. `/mfa` is the only page such a session can open, apart from the public
  ones; it shows a six-digit form (a choice of authenticator when there are several) and a sign-out button.
- **Limits.** Every code attempt is counted first (`hit_rate_limit`, `mfa.verify`, 10 per 15 minutes per person); enrolling is 10 an hour.
  Supabase Auth has its own limits besides. Wrong codes are explained in words from the error `code`
  (`lib/auth/mfa-errors.ts`), never by showing the server's message. Nothing logs a code, a secret, a QR code or a URI.
- **Removing an authenticator** asks Supabase Auth, which wants an aal2 session for a factor that is switched on, so a stolen password
  cannot switch the second step off.
- **Whether an organisation _requires_ an authenticator** for privileged actions is a separate, database-level setting: see "Requiring
  MFA for an organisation" below.

#### Lost device: the support runbook

Supabase Auth gives the app no recovery codes it can rely on (see the table below), so a person who loses every authenticator cannot get
past the second step alone. The screens say so and ask people to add a second authenticator. When they have lost all of them:

1. **Who may ask.** The person, from the address on the account. Or the owner of their organisation, in writing, on their behalf. A
   sole owner has no one above them and must ask for themselves.
2. **Verify first** (the checks in `docs/popia-operations.md`, section 1): a reply from the account's address; for an owner, or when that
   address is also lost, a government identity document matching the name on the account, which is checked and then deleted, plus written
   confirmation from another owner where there is one. If in doubt, do not proceed and tell the Information Officer.
3. **Who approves.** The Information Officer (or a named deputy) signs off on the ticket. A member's reset may be approved on the
   written confirmation of their organisation's owner; **an owner's or admin's reset needs the Information Officer's approval**, because
   those roles approve and send bids. Nobody can do this from inside the app: there is no screen for it.
4. **Run it** as the request handler, with the ticket reference (letters, digits and `. _ : -`; never a name or address):
   `npm run popia -- reset-mfa <user-id> --ref REQ-2026-021 --yes`. It removes the person's authenticators and **ends every session
   they have** (so a stolen device or session stops working at once), audits `mfa.reset` with the reference and counts, and is limited to
   three a person an hour (`public.reset_user_mfa`, service role only, migration 062).
5. **Tell the person** to sign in with their password (reset it first if the device was stolen), set up a new authenticator and add a
   second. If the device was stolen, also review the audit trail and revoke their browser pairing codes (Settings, Browser helper).
6. **Record** the ticket, who verified, who approved, and when. Do not store the identity document.

### Requiring MFA for an organisation (aal2 enforcement)

An owner can switch on **Require MFA for everyone** in Settings, Security (`system_settings.require_mfa`, off by default, migration 063).
While it is on, the actions below refuse any session that has not passed an authenticator challenge, that is, whose JWT `aal` claim is
not `aal2`. Signing in and reading stay open, so someone who has not set one up can still get in and do that.

- **Where the check lives.** `private.require_aal2(org)` raises SQLSTATE **P0403** when the organisation requires MFA and the session is
  below aal2. It does nothing when there is no signed-in user (`auth.uid()` is null), so the worker, the service role and the agents are
  unaffected. It is called, after each function's role check, by: `set_kill_switch`, `set_agent_control`, `decide_approval`,
  `set_watched_provinces`, `set_watched_methods`, `register_company_document`, `verify_company_document`, `archive_company_document`,
  `document_download`, `connect_email_account`, `disconnect_email_account`, `record_bid_delivery`, `rerun_bid`, `change_tender_delivery`,
  `create_autofill_token`, `change_member_role`, `remove_member`, `create_invitation`, `revoke_invitation` and `resend_invitation`. Starting
  and cancelling workflows, retrying tasks and creating tenders stay open: they are what operators do all day, and the dangerous steps
  (approval, sending, delivery) are gated.
- **How those functions were changed.** Migration 063 re-creates each one whole from its migrated definition (`pg_get_functiondef`) with
  one added line, never by text replacement, and keeps the rate-limit lines (`tests/integration/hardening.test.ts` checks both the
  `hit_rate_limit(` and the `require_aal2(` line in every one, so a later migration that copies an older version fails the test).
- **Documents.** `private.can_read_document` (used by the Storage read policy and `document_download`) also needs aal2 for director IDs,
  bank letters and proof of address, on top of the owner or admin role. Other documents stay readable at aal1 through Storage;
  `document_download` needs aal2 for every document.
- **Switching it.** `set_require_mfa` is for owners, rate limited and audited (`settings.require_mfa_on` or `_off`), and notifies every member.
  The caller must be at aal2 **in both directions**: an owner who has not set up an authenticator cannot switch it on (nobody is locked out by
  the person who turned it on, and the page says "set up yours first"), and a stolen password cannot switch it off. Switching it on revokes
  browser pairing codes made below aal2 (`autofill_tokens.created_aal`; a pairing made before the column existed counts as below). The last
  authenticator of a member cannot be removed while it is on.
- **Lock-out risk, in plain words.** Members without an authenticator can sign in and read, but cannot approve, send, change settings,
  manage the team, connect mailboxes, pair the browser helper or work with documents until they set one up in Settings, Security. Viewers
  too, for documents. A banner in the app says so, and the toast for a refused action links to `/mfa`, which says to set one up when there is
  none. Before switching it on: set up your own, and ask admins and operators to set up theirs. If someone cannot, support can reset a lost
  authenticator (above) but cannot switch it off for the organisation: that needs an owner at aal2.
- **Paths that skip the database's check.** `requireAal2(ctx)` (`lib/auth/require-aal2.ts`) repeats the rule, from the session's own `aal`,
  where an action runs as the service role or does outside work first: `sendBidEmail`, `connectSmtp`, `registerDocument`,
  `createAutofillToken` and `createBrowserPairing`, the organisation export download, and `/api/email/google/start` and `/callback`.
  It refuses when the level cannot be read. `toUserError` maps P0403 to the same message ("Verify with your authenticator to do this."), and
  the toast adds a "Verify now" link.
- **Tested** with the claims set the way PostgREST sets them (`tests/integration/aal2.test.ts`: all twenty functions refuse aal1 with
  P0403 and accept aal2, the switch, the pairing codes, documents and Storage, the worker); a real aal2 token needs a TOTP-enabled Auth server
  (`tests/integration/mfa.test.ts`). `has_org_role` keeps its signature.

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

| Assumption                                                                                                                                                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Source                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Vercel overwrites `X-Forwarded-For` so a client cannot forge its address                                                                                                                      | **Verified.** Vercel documents that it overwrites `X-Forwarded-For` and does not forward external IPs, to prevent spoofing. `x-real-ip` equals it. `x-vercel-forwarded-for` equals it too but is not overwritten when another proxy sits in front of Vercel. Only Enterprise trusted proxies may pass a custom value.                                                                                                                                                                                                                                                                                                                                                                                                                      | vercel.com/docs/headers/request-headers                                                        |
| Turnstile `siteverify` request and response shape                                                                                                                                             | **Verified.** `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret` and `response` (form or JSON; `remoteip` and `idempotency_key` optional). Response has `success`, `challenge_ts`, `hostname`, `error-codes`, `action`, `cdata`. A token is valid 300 seconds, is single-use (a replay fails with `timeout-or-duplicate`) and is at most 2048 characters. Cloudflare's published test keys return `action: "test"`, so the action is not checked.                                                                                                                                                                                                                                                              | developers.cloudflare.com/turnstile/get-started/server-side-validation, /reference/testing     |
| Turnstile with a nonce + `strict-dynamic` CSP                                                                                                                                                 | **Verified from docs, not run in a browser.** Cloudflare lists `challenges.cloudflare.com` for script-src and frame-src, says Turnstile propagates the nonce and works with `strict-dynamic`, and says connections to that origin must be allowed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | developers.cloudflare.com/turnstile/reference/content-security-policy                          |
| Sign-up for an existing address, with confirmations on, returns a fake user and no error                                                                                                      | **UNVERIFIED by experiment.** The supabase-js reference only warns that "you may get back an error message that attempts to hide this information"; secondary sources describe an obfuscated user (empty `identities`, no session) with confirmations on and "User already registered" with them off, and say an unconfirmed address is re-sent the email. The local stack in use runs with confirmations off and its Auth container could not be recreated, so the confirmations-on path was never exercised. The app does not depend on which one Supabase picks: success with no session, `user_already_exists` and `over_email_send_rate_limit` all produce the same reply (unit-tested). Re-check on a staging project before launch. | supabase.com/docs/reference/javascript/auth-signup (partial)                                   |
| Unconfirmed address, resend, and `token_hash` links                                                                                                                                           | **Verified on the local stack** (`tests/integration/auth-confirmation.test.ts`): sign-in fails with `email_not_confirmed`; the resent email reaches the mail catcher with a verify link that confirms the address; a `token_hash` from `generateLink` verifies once in a client with no PKCE state, and a forged hash is refused. Auth treats magic-link and recovery hashes as interchangeable.                                                                                                                                                                                                                                                                                                                                           | local run                                                                                      |
| PKCE confirmation links fail when opened in another browser                                                                                                                                   | **Verified.** The code verifier is stored only in the browser that started the flow, so the code exchange must happen there. The auth code lives 5 minutes and can be exchanged once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | supabase.com/docs/guides/auth/sessions/pkce-flow                                               |
| TOTP can be switched on in `config.toml`, and the local Auth container reads it                                                                                                               | **Verified, with a gap.** `[auth.mfa.totp] enroll_enabled` and `verify_enabled` map to `GOTRUE_MFA_TOTP_ENROLL_ENABLED` and `GOTRUE_MFA_TOTP_VERIFY_ENABLED` (read, not changed, from the running `supabase_auth_tenderos` container's environment, where both were `false` from the old config). A container reads them only at creation, so the stack must be recreated from this config (`supabase stop` then `supabase start`); a restart is not enough. **The running Auth container was not recreated here** (the permissions system refused it, and the repo brief forbids stopping the stack), so nothing below that needs a TOTP-enabled server was run.                                                                          | `docker inspect` (read-only), `supabase/config.toml`                                           |
| `mfa.enroll` response: `id`, `type`, `friendly_name`, `totp.qr_code`, `totp.secret`, `totp.uri`; the QR code is an SVG                                                                        | **Verified in the installed client** (`@supabase/auth-js` 2.117.3 types and source) and in the supabase-js reference. The client prepends `data:image/svg+xml;utf-8,` to the SVG; the app draws a QR code only when it starts `data:image/svg+xml;`. Not run against a server.                                                                                                                                                                                                                                                                                                                                                                                                                                                             | node_modules/@supabase/auth-js, supabase.com/docs/reference/javascript/auth-mfa-enroll         |
| `mfa.verify` returns a new session, which the client stores; `mfa.challengeAndVerify` is challenge then verify                                                                                | **Verified in the installed client's source** (it saves the returned session and notifies subscribers). That the new token carries `aal: "aal2"` is what the documentation says ("the client library will refresh the session in the background automatically"; `aal2` means a second factor was verified) but was **UNVERIFIED by experiment**.                                                                                                                                                                                                                                                                                                                                                                                           | auth-js `GoTrueClient.js`, supabase.com/docs/guides/auth/auth-mfa/totp                         |
| `getAuthenticatorAssuranceLevel()`: `currentLevel` is the token's `aal` claim, `nextLevel` is `aal2` when the user has a verified factor, `currentAuthenticationMethods` is the `amr` claim   | **Verified in the installed client's source.** Called without a token it reads the stored session, so it is local and quick (the reference says "microseconds, rarely uses the network"); with a token it asks the server. `nextLevel` comes from the stored session's user, which a new session replaces, so it is as fresh as the last sign-in or verify.                                                                                                                                                                                                                                                                                                                                                                                | auth-js source, supabase.com/docs/reference/javascript/auth-mfa-getauthenticatorassurancelevel |
| `mfa.listFactors()`: `all` holds every factor (verified or not), and each per-type list holds verified ones only                                                                              | **Verified in the installed client's source.** The types include `totp`, `phone`, `webauthn` and `recovery_code`, so the app filters on `factor_type === "totp"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | auth-js source                                                                                 |
| A verified factor cannot be removed from an aal1 session                                                                                                                                      | **Documented, not run.** The reference says "A user has to have an `aal2` authenticator level in order to unenroll a `verified` factor"; the error code is `insufficient_aal`, which the app turns into "Verify with your authenticator, then try again".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | supabase.com/docs/reference/javascript/auth-mfa-unenroll, `lib/auth/mfa-errors.ts`             |
| Error codes for MFA (`mfa_verification_failed`, `mfa_challenge_expired`, `mfa_factor_name_conflict`, `too_many_enrolled_mfa_factors`, `insufficient_aal`, `mfa_totp_enroll_not_enabled`, ...) | **Verified to exist** in the installed client's error-code list. One was observed from the real local server: with TOTP off, `mfa.enroll` answers `mfa_totp_enroll_not_enabled` (the integration and end-to-end probes rely on it, and the app turns it into "not switched on for this TenderOS server"). Which call returns the others was not observed. An unknown code gets a generic message.                                                                                                                                                                                                                                                                                                                                          | auth-js `lib/error-codes.d.ts`                                                                 |
| A TOTP code is valid for its 30 second step, with one step of clock skew                                                                                                                      | **Documented.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | supabase.com/docs/guides/auth/auth-mfa/totp (FAQ)                                              |
| Supabase has no built-in recovery codes (plan assumption)                                                                                                                                     | **Out of date, but not usable yet.** The installed client has `auth.mfa.recoveryCodes` (generate, regenerate, verify, unenroll), disabled unless `auth: { experimental: { recoveryCodes: true } }`, with a note that experimental APIs "may change without notice"; the local database has `auth.mfa_recovery_code_sets` and the client knows `mfa_recovery_codes_*` errors. Whether the hosted service offers it, and on which plans, is **UNVERIFIED**. TenderOS does not use it: the lost-device runbook above, and a second authenticator, are the plan. Revisit when it is generally available.                                                                                                                                       | auth-js source and types, local database schema                                                |
| TOTP MFA is available on the hosted plan                                                                                                                                                      | **Partly verified.** The pricing page lists "Basic Multi-Factor Auth: Included" for Free, Pro and Team, and only phone MFA as a paid add-on; it does not name TOTP, and the comment in the CLI's generated `config.toml` says "Pro". Treat TOTP on the plan you will use as **UNVERIFIED** until a staging project has been checked.                                                                                                                                                                                                                                                                                                                                                                                                       | supabase.com/pricing                                                                           |
| The `aal` claim is in the JWT the database sees, and `auth.jwt()->>'aal'` can be tested in SQL                                                                                                | **Verified for the database side** (`tests/integration/aal2.test.ts` sets `request.jwt.claims` the way PostgREST does); that GoTrue puts `aal` in every access token is documented.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | supabase.com/docs/guides/auth/auth-mfa                                                         |

Everything marked UNVERIFIED above can be settled by one run of `tests/integration/mfa.test.ts` against a stack whose Auth container
was created from this `config.toml`: it enrols a factor, answers the challenge with a code computed in the test (RFC 6238, `node:crypto`),
and checks the session's level, the sign-in redirect condition and the unenrol rule. On a stack without TOTP it skips itself with a note.

## What is tested, and what is not

- **Unit tests** (mocked Supabase): link building from `APP_URL` with forged headers; the limiter,
  its keys, address parsing and fail-closed behaviour; the CAPTCHA verifier; the sign-up, resend,
  sign-in, reset and consent actions; the confirm and callback routes; the legal pages' content;
  the wizard's schema and actions; `requireContext`. Teams and MFA: the member and invitation actions,
  the invite route and cookie, the platform mailer and the invitation email (fake transport), the
  join action, the role menu rules, the TOTP helper against the RFC 6238 vectors, the MFA helpers,
  the sign-in and middleware redirect to `/mfa`, the MFA actions, `requireAal2` and every service-role
  path that calls it, and `reset_user_mfa`'s wrapper.
- **Integration tests** (real local Auth, database and mail catcher): the limiter against
  `hit_rate_limit_key` and the sweeper; unconfirmed sign-in, resend and `token_hash` verification;
  consent at sign-up and `accept_legal`; the unique membership index, the bootstrap race and the
  migration's pre-check; keyword constraints and `complete_onboarding`. Teams and MFA: member
  management and the last-owner rule under concurrency (`members.test.ts`); invitations, their
  tokens, limits, acceptance rules and POPIA handling (`invitations.test.ts`); `reset_user_mfa`
  (`mfa-reset.test.ts`); the second-factor requirement for all twenty functions, the switch, pairing
  codes and documents (`aal2.test.ts`, with the session's claims set as PostgREST sets them); and the
  catalogue checks in `hardening.test.ts`. `mfa.test.ts` (a real TOTP enrolment, challenge and aal2
  session) skips itself when the Auth server has TOTP off.
- **End to end** (production build, Chromium): sign-up with the terms box through the wizard to an
  approved bid; `/auth/confirm` opened in a browser that never asked for the link; re-acceptance of
  the terms, the dashboard prompt and skipping the wizard. Teams and MFA: an owner invites an auditor
  from Settings, who opens the link with no session, creates an account, joins as a read-only viewer
  and sees the organisation, after which the owner changes their role and removes them; Settings,
  Security with the requirement on (the banner, the refused action, the "Verify now" link); and, on a
  stack with TOTP on, setting up an authenticator, the challenge at sign-in and the redirect.
- **Not exercised.** The local stack is started from `supabase/config.toml` and may have been started
  before confirmations were turned on there; when it has not been restarted, sign-up signs the user in
  at once and the milestone test follows that branch. To exercise confirmation end to end, restart
  the stack from this config, after which the milestone test reads the confirmation email from the mail
  catcher instead. Also not run: the Turnstile widget in a browser (needs a real or test site key and
  the stack), the hosted project's settings, and any real inbox.
- **Not exercised: authenticator apps against a real Auth server.** The running local Auth container was
  created from a config with TOTP off, and a restart does not change that; recreating it from this
  `config.toml` (`supabase stop`, `supabase start`) was not possible in the session that built this. So
  `tests/integration/mfa.test.ts` and the TOTP end-to-end test were written but have **never run**: they skip
  themselves with a note. Until they have, the server-side facts marked UNVERIFIED above are exactly that.
- **Not exercised: the invitation email itself** reaching a real inbox (no provider is chosen; the end-to-end run
  has no mail server and takes the "share the link" path), and the platform mailer against a real SMTP server.
