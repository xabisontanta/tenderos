# POPIA operations: data-subject requests, retention and breaches

**Status: working runbook written by an AI assistant. It is not legal advice.** The time limits, the
retention periods and the wording sent to people are for a South African attorney to confirm
(`docs/legal/popia-overview.md`, open points). What the tooling does is described exactly; what the law
requires of you is for the Information Officer to decide.

Who is who: the customer company is the responsible party for the data it puts in TenderOS; TenderOS is
its operator, and the responsible party for the account data of the people who sign in
(`docs/legal/popia-overview.md`). The runbook below covers both, and says which applies.

## Roles

| Role                                  | Does                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Information Officer** (to be named) | Receives requests and breach reports, decides, signs off erasures, keeps the register.            |
| **Request handler**                   | A named engineer with the service-role key. Runs the commands below. Never acts without a ticket. |
| **Organisation owner**                | Downloads their own organisation's data from Settings, Your data. Can ask for erasure.            |

The same people, with the same identity checks (section 1), also handle a **lost authenticator** (`npm run popia -- reset-mfa`, the
runbook and who may approve it are in `docs/auth.md`, "Lost device").

Only the request handler has the service-role key. The commands refuse to run without it, and
`erase_user`, `erase_organisation`, `export_user_data` and `export_organisation_data` are not callable by
any signed-in user (an integration test checks the grants).

## 1. Receiving and verifying a request

1. Log it in the ticket system with a reference such as `REQ-2026-014`. The reference is the only
   identifier that goes into the database record; **never put a name, address or id number in it**
   (the functions reject anything but letters, digits and `. _ : -`).
2. Say what is asked: access (s23), correction (s24), deletion or destruction (s24), objection.
3. **Verify identity before anything is disclosed or deleted.**
   - A signed-in owner asking for their organisation's data needs no further check: they use Settings.
   - Anyone else: reply only to the email address on the account, and ask for a short statement
     sent from that address. For an organisation, the request must come from an owner of that
     organisation. For a request on behalf of another person (a consultant, an attorney), ask for a
     signed mandate and a copy of the requester's identity document, check it, and delete the copy when done.
   - If the address on the account can no longer be used, ask for a government identity document
     matching the name on the account and an owner of the organisation to confirm in writing. If still in doubt, do not proceed; tell the Information Officer.
4. Record the identity check in the ticket (who checked, how, when). Do not store the identity document.

**Time.** Acknowledge within 3 working days. The plan is to complete within 30 days of verification
(the period PAIA gives a private body for access requests); the Information Officer confirms the period
that applies. If it will take longer, tell the person before the deadline and why.

## 2. Access: what we hold about a person

Run, as the request handler:

```
npm run popia -- export-user <user-id> --by <your-user-id> --out REQ-2026-014.json
```

The result has these sections: `subject` (sign-in details), `profile`, `membership`, `consents` (which
document versions were accepted and when), `mailboxes` (never the credential), `browser_helper_pairings`
(never the code), `notifications`, `tenders_created`, `documents_uploaded` (details only, not the files),
`emails_sent`, `approvals_decided`, `invitations_received` (invitations addressed to their sign-in address, never the token), `invitations_sent` (a count) and `audit_entries` (what they did). Each list is capped (the `limits`
section says at how many), and the export itself is written to the audit trail.

- The file holds personal data. It is written with owner-only permissions. Send it through a secure
  channel (not plain email with the data in the body), confirm receipt, then delete your copy.
- Look through it before sending. Entries that name other people (a colleague in an approval comment) are
  that other person's data too; remove or summarise them if the Information Officer says so.
- Find a user's id with `select id from auth.users where lower(email) = lower('<address>')` after
  the identity check.

For an **organisation**, the owner presses **Download organisation data** in Settings (owner only, three
downloads an hour, audited), or the handler runs `npm run popia -- export-org <org-id> --out ...` when the
owner cannot. The file holds the company profile, documents (details only), tenders, status history, workflow runs
and their task outputs, approvals, submission records, mailboxes (no credentials), sent emails, discovery
runs, the event stream and the audit log, the members' names and roles (not their email addresses) and the
invitations that have not been purged yet (the invited address, role and dates, never the token).

## 3. Correction

- **Organisation data** (company profile, documents, tenders): owners and admins correct it themselves in the
  app. Tell the requester where.
- **A person's name** (`profiles.full_name`): there is no screen for it yet. The handler updates it after the
  identity check: `update public.profiles set full_name = '<corrected>' where id = '<user-id>'`, and notes the
  ticket. **Email address**: the person changes it in their own account (Supabase Auth asks both addresses to confirm).
- The audit trail is not corrected: it records what happened. If an entry is wrong, add a note to the ticket
  and tell the person it is kept as a record of events.

## 4. Erasure

### What it does

`erase_user` (one person) and `erase_organisation` (a customer leaving) are database functions, run through
`npm run popia`. Each runs in one transaction, so it is all done or nothing is.

**A person** (`erase-user`)

- Deletes the sign-in account and everything tied only to it: profile, membership, mailboxes **and their
  credentials in Vault**, browser pairing codes, notifications, consent records and sessions, and Supabase
  Auth's own log entries for them.
- Keeps the organisation's records, with the person removed from them: audit entries, events and tender
  status history lose the actor id, network address, browser and anything they typed (comments, reasons,
  labels, notes); any email address anywhere in those records is replaced; sent-email records keep that a
  bid was sent but not who sent it or to whom; company-profile contact fields that were theirs are cleared;
  approval comments are replaced.
- Writes one audit entry, `popia.user_erased`, holding a random pseudonym, your reference and counts. It
  holds no name, address or user id.
- **Refuses** when the person is the only owner of an organisation that has other members (an owner of that
  organisation makes someone else an owner first, in Settings, Team: change the role to Owner, which is the
  ownership transfer; it never needs a database edit), and when they are the only member (erase the
  organisation instead). A member who has already been removed in Settings, Team has no membership left and
  can be erased directly; removing them revoked their browser pairing codes and disconnected their mailboxes.

**An organisation** (`erase-org`)

- Removes the organisation's files from Storage first (including uploads that were never registered), then
  deletes the organisation, **every member's account** (a person belongs to one organisation only), its
  tenders, documents, tasks, approvals, sent-email records, events, tender history, cost records, mailboxes and
  their Vault credentials, and the rest of its rows.
- Keeps its **audit trail**, de-identified in the same way, for the retention period below, and writes
  `popia.organisation_erased` (reference, counts).

### Before you run it

1. Verified request, ticket reference, Information Officer's approval on the ticket.
2. Tell the requester what will and will not be removed (below) and that it cannot be undone.
3. For an organisation: ask the owner to download their data first (Settings), and engage the kill switch
   so no worker is mid-run on it (`select public.set_kill_switch(...)` is for signed-in admins; as handler, set
   `system_settings.kill_switch = true`). Wait for running tasks to finish.
4. Do a dry look: `npm run popia -- export-org <org-id>` or `export-user <user-id>` and check it is the right
   person or organisation.

### Run it

```
npm run popia -- erase-user <user-id> --ref REQ-2026-014 --yes
npm run popia -- erase-org  <org-id>  --ref REQ-2026-014 --yes
```

The output is a summary of counts and a pseudonym. Keep it in the ticket. If it fails, nothing was
deleted from the database; read the message, fix the cause, run it again (for an organisation, the files
may already be gone, which is fine).

### What is kept, and why

| Kept                                                | Why                                                                                                                                                                                                                                      | For how long                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Audit trail (action, resource, time), de-identified | Evidence of what happened to a customer's bids and to their data; security investigations; legal claims                                                                                                                                  | `audit_retention_days` of the organisation, at least 365; 2555 (about seven years) for an erased organisation |
| `popia.*` audit entries                             | Proof that a request was handled, with no personal data in it                                                                                                                                                                            | As the audit trail                                                                                            |
| Cost records of an organisation that stays          | Audit of AI spend                                                                                                                                                                                                                        | As the audit trail                                                                                            |
| Backups                                             | Supabase keeps database backups for the period of the plan (set it to the shortest that meets recovery needs). Erased data leaves backups when they expire; a restore must re-run the erasures from the ticket log                       | Provider setting (confirm and record it here: ____)                                                           |
| Data at sub-processors                              | Anthropic, Google (if Gmail sending was used), the email provider and hosting each have their own retention; tell the requester which apply. TenderOS never sends director personal data, bank details or proof of address to Anthropic. | Per provider                                                                                                  |
| Consent records                                     | Deleted with the account at present. Whether proof of consent must outlive the account is an open point for the attorney                                                                                                                 | n/a                                                                                                           |

### After

1. Confirm: `select count(*) from auth.users where id = '<user-id>'` is 0; for an organisation, no row in
   `public.organisations`.
2. Reply to the requester, naming what was erased, what was kept and why, and when backups clear.
3. Close the ticket. Do not copy personal data into it.

### Why storage is done by code, not SQL

Supabase refuses direct deletes on `storage.objects`; only its Storage API removes a file. So
`lib/privacy/erasure.ts` lists the organisation's folder (and every sub-folder), removes the files, and only then calls
`erase_organisation`. A file left behind would be unreachable (the database no longer knows it) but would
still be personal data, which is why files go first.

## 5. Retention

`private.run_retention_purge()` runs every day at 03:30 UTC (pg_cron job `tenderos-retention-purge`, created by
migration `20261010000053`). Where pg_cron is missing, schedule `select private.run_retention_purge()` elsewhere.

| Data                                             | Kept                                                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed jobs                                   | 30 days                                                                                                                                              |
| Dead (failed) jobs                               | Until their organisation is erased                                                                                                                   |
| Agent events (the live activity stream)          | 365 days                                                                                                                                             |
| Notifications                                    | 90 days                                                                                                                                              |
| Audit log and cost records                       | `system_settings.audit_retention_days` (default 2555 days, never below 365); an erased organisation keeps the default                                |
| Rate-limit counters                              | 1 day (existing hourly sweep)                                                                                                                        |
| Team invitations (they hold the invited address) | 30 days after accepted, withdrawn or expired (`private.purge_invitations`, daily 03:40 UTC); deleted at once with the account they were addressed to |
| Mailbox credentials with no mailbox              | Deleted by the daily purge; also deleted at once with their mailbox                                                                                  |
| Everything else                                  | Until the person or organisation is erased                                                                                                           |

Each run that deleted anything writes a `retention.purged` audit entry with counts. The periods are
decisions for the Information Officer: change them in the migration's function and update this table.

## 6. Security compromises (breaches)

POPIA s22 requires the responsible party to notify the Information Regulator and the affected people as soon as
reasonably possible after a compromise of personal information; as an operator, TenderOS must tell the
customer immediately. This is the plan. The Information Officer (or deputy) owns it; fill in the contact tree
before launch.

1. **Detect and report.** Anyone who suspects exposure (a lost laptop with the service-role key, a leaked
   repository secret, unexpected audit entries, a customer report) tells the Information Officer at once, in
   writing, with what they saw. Do not investigate alone or delete evidence. Error reporting and alerting are
   not built yet (`docs/production-readiness.md`); until they are, review the audit log and Supabase's
   own logs weekly.
2. **Contain.** In this order, as relevant:
   - engage the kill switch for affected organisations (stops every agent);
   - rotate the Supabase service-role key and database password, `AUTH_RATE_LIMIT_SECRET`, `WORKFLOW_SECRET` and the AI key;
   - revoke browser pairing codes (`update public.autofill_tokens set revoked_at = now() where revoked_at is null`);
   - force sign-out (revoke sessions in Supabase Auth) and ask affected people to change passwords;
   - disconnect mailboxes that may be exposed (the credentials are in Vault; disconnecting deletes them) and tell the owners to rotate their mailbox passwords.
3. **Assess.** What was reached, whose data (customers' company data, directors' ID documents, bank letters,
   people's sign-in details), how many people, since when, whether it was readable, and whether it is
   continuing. The audit log and Supabase's API and database logs are the sources; export them before they roll over.
4. **Notify.** Information Officer decides and signs off. Customers (as their operator): without delay,
   with what happened, what data, what we are doing, what they should do. The Regulator and affected people:
   as soon as reasonably possible, using the Regulator's form and the content POPIA s22(5) requires (description of the
   possible consequences, the measures taken, recommendations to the person, and, if known, the identity of the
   unauthorised person). Delay only as a law-enforcement agency or the Regulator directs.
5. **Record.** Keep a register: date found, date reported, what, whose, containment, notifications sent
   (who, when, how), root cause, fix. Keep it for at least the audit retention period.
6. **Learn.** Within two weeks write what failed and what changes; add a test where a test would have caught it.

## 7. Open points for the attorney

1. Time limits and the form of acknowledgements, access responses and refusals.
2. Whether proof of consent must outlive the account (today it is deleted with the account).
3. How long an erased organisation's de-identified audit trail may be kept, and whether the default of
   2555 days is right.
4. Retention periods in section 5, in particular the 365-day event stream.
5. Backups: the period, and whether re-running erasures after a restore is enough.
6. Who is the Information Officer, and where requests and breach reports are received.
