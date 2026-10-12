# Email

Every email a customer receives from TenderOS is branded, detailed and built
from one source: `emails/`. There are 18 of them.

| Sent by            | Emails                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase Auth (13) | Confirm sign-up, invite user, magic link, reset password, change email address, reauthentication code; security notices for password changed, email changed, phone changed, verification method added, verification method removed, sign-in method linked, sign-in method removed |
| The app (5)        | Team invitation, welcome and setup checklist, approval needed, bid delivered, closing-date digest                                                                                                                                                                                 |

The five app emails are pure render functions that return
`{ subject, html, text }`. The **team invitation** is wired in (see "Platform
mailer" below); the other four are not called yet and are wired in by the
feature they belong to (when notifications get an email channel). The Supabase
emails are live as soon as the templates are applied (see "Hosted Supabase
checklist").

## Platform mailer: the emails the app sends itself

`lib/email/platform.ts` sends the app's own emails (today the team invitation, through
`lib/email/team-invitation.ts`, which calls `renderTeamInvitation`). It is separate from the customer's
mailbox that sends bids (`lib/email/smtp.ts`, `gmail.ts`) and from Supabase Auth's mailer. It reads the
same variables as the Supabase SMTP settings, so one provider and one verified sending domain serve both:

| Variable    | Meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| `MAIL_FROM` | The From header: `no-reply@example.com` or `TenderOS <no-reply@example.com>`    |
| `SMTP_HOST` | The provider's submission host name (a name, not an IP address)                 |
| `SMTP_PORT` | 465 (implicit TLS), 587 (STARTTLS, the default) or 2525; port 25 is not offered |
| `SMTP_USER` | Optional login; set `SMTP_USER` and `SMTP_PASS` together or not at all          |
| `SMTP_PASS` | The login's password                                                            |

- **Provider-neutral.** Any SMTP submission service. No provider has been chosen (product owner).
- **TLS 1.2 or later**, certificate validated against the host name; the host must resolve to public
  addresses (the same rule as customers' mailboxes, `lib/email/network.ts`), and the connection goes to the
  address that was checked. A local catcher such as Mailpit is therefore **not** usable as `SMTP_HOST`.
- **Not configured, in development:** nothing is sent, an info line says so, and the caller is told
  `delivered: false`. Tests and local work need no SMTP server.
- **Not configured, in production:** an error log names the missing variables, and the caller gets a failure.
  Half-set configuration (a host without a sender, a user without a password, port 25) is a failure in every
  environment, so it is never mistaken for "off".
- **A failed send never loses the invitation.** The invitation is created first. The inviter is told the email
  did not go and is handed the link (once) to pass on; Resend makes a new link and tries again.
- **Logs** carry the kind of email (`team_invitation`) and an error code. Never a recipient, subject, body,
  link or credential.
- **The link** is `${APP_URL}/invite/<token>` (docs/auth.md, "Teams and invitations"). In production it must be
  https, or the renderer refuses and the email fails (the end-to-end run, served over local http, takes that path).
- **UNVERIFIED:** delivery to a real inbox, SPF/DKIM/DMARC alignment, and rendering of this email in real mail clients, as for
  every email here (no provider was chosen, nothing was sent to a real address).

Status words used below: **verified** means checked against the official
Supabase documentation or the Supabase CLI 2.120 binary in `node_modules`.
**UNVERIFIED** means not checked, usually because it needs a real mailbox or a
hosted project.

## Design system

The emails use the product's own tokens (`app/globals.css`, converted from
oklch to sRGB hex in `emails/layout.ts`) and its logo.

| Token            | Light                               | Dark                                    | Notes                                                                            |
| ---------------- | ----------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| Page             | `#f4f6f9`                           | `#090c11`                               | one step deeper than the app so the white card lifts                             |
| Card             | `#ffffff`                           | `#10141a`                               | 16px radius, 1px border, 4px cyan to violet bar on top                           |
| Text             | `#11161f`                           | `#e7ecf0`                               |                                                                                  |
| Muted            | `#5d646f`                           | `#9299a2`                               | at least 5.5:1 on card and page                                                  |
| Link and eyebrow | `#006e9e`                           | `#3ecce2`                               | the app primary `#007eb7` is exactly 4.5:1 on white, so text uses a deeper shade |
| Button           | `#006ea0` fill, white label (5.6:1) | `#3ecce2` fill, `#0a1018` label (9.9:1) |                                                                                  |
| Accent gradient  | `#50d9ef` to `#7575e9`              | same                                    | the logo gradient                                                                |

- Type: system sans stack (web fonts do not load in most clients), 28px
  headline, 16px body, 14px and 13px for detail. Monospace for codes and links.
- Layout: 600px column, nested `role="presentation"` tables, inline styles for
  everything that matters. One `<style>` block carries only dark mode and the
  375px layout.
- Header: logo mark plus the live-text word "TenderOS" and the tagline, as in
  `app/(auth)/layout.tsx`. The word is text on purpose, so it stays readable in
  clients that darken emails on their own.
- Body blocks (`emails/layout.ts`): paragraph, button with Outlook VML
  fallback and an expiry note, "button not working" link panel, code box,
  notice panel (info, success, warning, danger), details table, list, setup
  checklist, tender rows, "Didn't ask for this?" safety paragraph.
- Footer: tagline, Help, Privacy and Terms links, the legal sender block, and
  the reason the email was sent.
- Dark mode: `color-scheme` meta, `@media (prefers-color-scheme: dark)` with
  `!important` overrides keyed on classes, and `[data-ogsc]`/`[data-ogsb]`
  selectors for Outlook.com. The logo swaps between a light and a dark PNG.
  Clients that do not support the query (Gmail) apply their own inversion.
- Mobile: breakpoint at 620px; at 375px padding shrinks, the button goes full
  width and the details table stacks.
- Accessibility: every text pair is held at 4.5:1 or better by a test, links
  are underlined, the document has `lang="en-ZA"`, decorative images have
  `alt=""`, there is hidden preheader text, and every email has a plain-text
  twin (app emails only; see below).
- Images: PNG only. `public/email/` holds the mark and lockup (light, dark) and
  one gradient icon chip per email, each at 1x and 2x. Emails reference the 2x
  file with explicit `width`/`height`, so it is sharp on retina screens
  everywhere. They are served by Next from `public/`; the middleware matcher
  already excludes `.png`, so no login is needed (a test asserts it).

Copy rules: South African English, say what happened, what to do, how long a
link lasts and what to do if it was not them. Say only what TenderOS knows (a
delivery record means the mailbox accepted the message, not that the buyer
received it).

## Files

| Path                                                                             | What it is                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `emails/layout.ts`                                                               | tokens, shell, block renderers, escaping, link checks              |
| `emails/brand.ts`                                                                | name, tagline and the legal sender block                           |
| `emails/icons.ts`                                                                | the icon list and image file names                                 |
| `emails/templates/*.ts`                                                          | one module per email                                               |
| `emails/index.ts`, `emails/build.ts`                                             | registry of Supabase emails and the renderer                       |
| `emails/preview-data.ts`                                                         | sample data for previews and tests                                 |
| `supabase/templates/*.html`                                                      | generated, committed, read by the Supabase CLI                     |
| `supabase/config.toml`                                                           | `[auth.email.template.*]` and `[auth.email.notification.*]` blocks |
| `public/email/*.png`                                                             | generated, committed images                                        |
| `scripts/build-email-templates.ts`, `build-email-assets.ts`, `preview-emails.ts` | the tools below                                                    |
| `tests/unit/emails/`                                                             | tests; they run in CI without a browser                            |

## Edit and rebuild

1. Edit the module in `emails/templates/` (copy and structure) or
   `emails/layout.ts` (design). Do not edit `supabase/templates/*.html`.
2. `npm run build:emails` rewrites `supabase/templates/*.html`. Commit them.
   `npm run build:emails -- --check` fails if a committed file is stale, and a
   unit test does the same.
3. Changed the logo or the icon list? `npm run build:email-assets` re-renders
   `public/email/*.png` with Playwright (Chromium, or Edge or Chrome, or the
   binary in `PLAYWRIGHT_CHROMIUM_PATH`). Commit the PNGs.

The legal sender block reads these variables when the templates are built and
when an app email is rendered. Until they are set the footer shows
`[Registered company name]` style placeholders.

| Variable                    | Used for                                                       |
| --------------------------- | -------------------------------------------------------------- |
| `EMAIL_LEGAL_NAME`          | registered company name                                        |
| `EMAIL_LEGAL_ADDRESS`       | registered address                                             |
| `EMAIL_REGISTRATION_NUMBER` | CIPC registration number                                       |
| `EMAIL_SUPPORT_ADDRESS`     | "Questions? Write to ..."                                      |
| `EMAIL_ASSET_BASE_URL`      | optional https origin for the PNGs instead of `{{ .SiteURL }}` |
| `EMAIL_STRICT=1`            | make `build:emails` fail while a placeholder remains           |

The committed templates and the unit test must see the same values: either set
nothing (placeholders, the state in git today) or set the four values in the
build and the test environment together.

Adding an email: create the module, register it in `emails/index.ts` (Supabase
emails only), add the config block, run `npm run build:emails`, add a sample to
`emails/preview-data.ts`. The existing tests then cover it.

Rules the tests enforce on every email: required placeholders per template
type, only variables Supabase provides, no `.Data` (user-controlled metadata
would be injected into the markup), table layout with inline styles, no
scripts, stylesheets or web fonts, under 90 KB, images with alt, width and
height, a hidden preheader, subjects under 78 characters, https links, and
HTML escaping of everything the app interpolates.

## Preview

```
npm run preview:emails                    # index, frames and screenshots
npm run preview:emails -- --no-screenshots
npm run preview:emails -- --only=auth-recovery
npm run preview:emails -- --check         # also fail on overflow at 375px or a broken image
```

Open `emails/preview/index.html`: every email with its subject and inbox
preview text, light and dark side by side, desktop and mobile toggle. The same
run writes `emails/preview/screenshots/<email>.<light|dark>.<desktop|mobile>.png`
(desktop is a 720px viewport around the 600px column; mobile is 375px). Only a
representative set is committed; the rest is gitignored.

## Test with the local mail catcher

1. `npm run db:start` (the local stack uses the 563xx ports). The mail catcher
   is `[local_smtp]` in `supabase/config.toml`: web UI at
   <http://127.0.0.1:56324>. Its SMTP port is commented out (`smtp_port =
56325`); enable it only if you wire an app mailer to it.
2. After changing templates or `config.toml`, restart the stack (Supabase
   documents `supabase stop && supabase start`), because the CLI reads the
   templates at start.
3. Run the app (`npm run dev`). Local `auth.site_url` is
   `http://127.0.0.1:3000`, so the images in a local email load from the dev
   server's `public/email/`. Without the dev server running, images are broken
   in the catcher; that is expected.
4. Trigger real emails from the app: forgot password (recovery), sign-up with
   `enable_confirmations = true` (confirmation), and changing the password from
   the reset page (password-changed notice). The rest need the admin API or a
   feature the app does not have yet (invite, magic link, email change, MFA,
   identity linking, reauthentication).
5. Open the message in the catcher and check light and dark, the HTML source
   and the link (it should point at the local Supabase auth URL).

## Hosted Supabase checklist

Email rendering and delivery are the two things local testing cannot prove.

1. **Custom SMTP, before anything else.** Verified: the built-in Supabase SMTP
   only delivers to addresses in the project's team, is rate-limited, has no
   SLA and "is not meant for production use". Configure SMTP in the dashboard
   or through the Management API fields `smtp_admin_email`, `smtp_host`,
   `smtp_port`, `smtp_user`, `smtp_pass`, `smtp_sender_name`. Verified: the
   first limit after enabling custom SMTP is 30 messages an hour, adjustable
   under Auth rate limits. Provider choice is the product owner's; everything
   here is SMTP-generic and keeps credentials in environment variables
   (`supabase/config.toml` has a commented `[auth.email.smtp]` block that reads
   its password from `env(...)`).
2. **Sending domain.** Verified (Supabase docs): set up SPF, DKIM and DMARC for
   the sending domain, use a separate domain or subdomain and From address for
   authentication mail than for any marketing mail, and set up a Supabase
   custom domain so links do not share a spam reputation with other projects.
   The exact DNS records come from the SMTP provider.
3. **Branded From.** Name `TenderOS` and an address on that domain, for example
   `no-reply@auth.<your domain>` (`smtp_sender_name`, `smtp_admin_email`).
4. **Provider tracking off.** Verified: click tracking rewrites the links in
   the templates and breaks them.
5. **Site URL.** Set the hosted project's Site URL to the production https
   origin. The templates build image and footer links from `{{ .SiteURL }}`.
6. **Legal block and pages.** Set the four `EMAIL_*` values, build with
   `EMAIL_STRICT=1`, and make sure `/help`, `/privacy` and `/terms` exist and
   are public (the footer links to them; today the middleware sends signed-out
   visitors to `/login`, and the legal pages are plan slice S4).
7. **Apply the templates.**
   - Dashboard, Authentication, Email Templates: paste each file and subject.
     Verified.
   - Management API: `npm run --silent build:emails -- --management-api >
payload.json` writes the exact body, then `curl -X PATCH
https://api.supabase.com/v1/projects/$PROJECT_REF/config/auth -H
"Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type:
application/json" --data @payload.json`. Verified: the endpoint and field
     names are the ones in Supabase's "Email Templates" guide. The payload
     holds only `mailer_*` fields, so it cannot change SMTP or rate limits. It
     also switches the seven security notifications on.
   - `supabase config push`: **UNVERIFIED.** The CLI 2.120 binary knows the
     same `mailer_templates_*`, `mailer_subjects_*` and `mailer_notifications_*`
     fields, so it very likely pushes the `config.toml` blocks, but it also
     pushes every other `[auth]` setting (site URL, rate limits, password rules)
     and was not run here. Read its diff before accepting.
8. **Security notifications are off until enabled** at project level (verified);
   the Management API payload and the `enabled = true` entries do that.
9. **Link and code lifetime.** The copy says "1 hour" and a test ties it to
   `otp_expiry = 3600` in `config.toml`. Set the hosted "Email OTP expiration"
   to 3600 as well. UNVERIFIED: whether the invite link uses the same lifetime
   (the invite email therefore gives no number).
10. **Prefetching scanners.** Verified (Supabase docs): link scanners such as
    Microsoft Safe Links can consume `{{ .ConfirmationURL }}` before the person
    clicks, giving "token expired". If support sees this, switch the links to
    the documented `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=...`
    pattern with a `verifyOtp` route (plan slice S3). It is one constant per
    template.
11. **Look at every email in real inboxes** (Gmail web and app, Outlook
    desktop and Outlook.com, Apple Mail and iOS, one Android client) in light
    and dark. UNVERIFIED: none of that has been done.

## What is and is not verified

| Claim                                                                                                                                                 | Status                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13 Supabase emails exist and the `config.toml` keys, subject and `content_path` format                                                                | verified (docs and CLI 2.120 binary)                                                                                                                                                                                                                                         |
| Variables each email receives (`Email`, `NewEmail`, `OldEmail`, `Phone`, `OldPhone`, `Provider`, `FactorType`, `Token`, `ConfirmationURL`, `SiteURL`) | verified against the docs; a test rejects any other                                                                                                                                                                                                                          |
| `{{ .SiteURL }}` and `{{ .Email }}` are available inside the **notification** templates                                                               | UNVERIFIED. The docs list them as general variables but their examples for password changed and verification-method notices use neither. If a notice shows broken images, set `EMAIL_ASSET_BASE_URL` and rebuild; if it shows an empty address, remove it from that template |
| Go template `if eq` conditionals (used to turn `totp` into "Authenticator app")                                                                       | verified as Go templates by the docs; the evaluation was only simulated in `emails/preview-data.ts`. Values `totp`, `phone`, `webauthn` for `FactorType` UNVERIFIED                                                                                                          |
| Auth templates have no plain-text part                                                                                                                | verified: the API has an HTML field per email and no text field, so only app emails carry a text twin                                                                                                                                                                        |
| `content_path` is resolved from the project root (`./supabase/templates/...`)                                                                         | follows the repo's own scaffold and the docs' main example; the docs' notification example uses `./templates/...`. The CLI was not run. A test checks the files exist at the path used                                                                                       |
| Rendering in Gmail, Outlook (Word engine), Apple Mail, Outlook.com, Yahoo                                                                             | UNVERIFIED. Checked in Chromium only, with light and dark emulation and a 375px viewport. Expected in Outlook desktop: square corners, a solid cyan bar instead of the gradient, no dark mode. Expected in Gmail: its own colour inversion                                   |
| Hosted application of the templates                                                                                                                   | UNVERIFIED, nothing was applied to a hosted project                                                                                                                                                                                                                          |
| Deliverability (SPF, DKIM, DMARC, inbox placement)                                                                                                    | UNVERIFIED, no provider chosen                                                                                                                                                                                                                                               |
