# POPIA and related legal documents: overview (DRAFT)

**Status: working draft prepared by an AI assistant. It is not legal advice.**
A South African attorney must review and adapt every item before launch.
This file lists what TenderOS needs, why, and which product feature it
connects to, so the lawyer can be briefed quickly.

## Who is who

- **Customer company** (the business using TenderOS): the *responsible party*
  for its own company data and for the personal information of its directors,
  staff and contacts that it uploads.
- **TenderOS** (the operator of the platform): an *operator* for that customer
  data, and the *responsible party* for its own account data (names, emails,
  login and usage records of the people who sign in).
- **Consultants, accountants and auditors acting for a client:** usually
  operators or sub-operators of the client; the contract with the client must
  say so.
- **Sub-processors:** Supabase (database, storage, auth), the hosting
  provider (Vercel or similar), Anthropic (AI), Google (Gmail sending, if
  used), the transactional email provider (to be chosen).

## Documents to prepare

| # | Document | Why | Connects to |
| - | -------- | --- | ----------- |
| 1 | **Privacy notice** | POPIA s18: say what is collected, why, who receives it, where it goes, and how to exercise rights. | Linked from sign-up, footer, emails; `/privacy` page |
| 2 | **Terms of service / subscription agreement** | Contract with the customer: acceptable use, no guarantee of award, human approval of every submission, AI limits, liability cap, termination, governing law. | Sign-up consent (`legal_acceptances`); `/terms` |
| 3 | **Operator agreement (data processing agreement)** | POPIA s20-21: written contract between customer (responsible party) and TenderOS (operator): purposes, security, sub-operators, breach notice to the customer, return or deletion on exit. | Accepted in the terms or signed per customer |
| 4 | **Sub-processor list** | Transparency and cross-border basis. Name each provider, purpose, location, safeguards. | Linked from privacy notice |
| 5 | **Cross-border transfer basis** | POPIA s72: data held outside South Africa (Supabase has no SA region; AI provider abroad). Rely on binding agreements providing adequate protection, or consent where needed. | Hosting decision; privacy notice |
| 6 | **Information Officer registration** | The Information Officer (and any deputy) must be registered with the Information Regulator. Name an owner. | Contact details in privacy notice |
| 7 | **PAIA manual** | PAIA s51 manual for private bodies; check whether an exemption applies. | Public link in footer |
| 8 | **Data subject request procedure** | Access (s23), correction (s24), deletion, objection. Includes a request channel, identity check, response times, and the prescribed forms. | Needs export and erasure tooling (roadmap) |
| 9 | **Retention and deletion schedule** | Keep records no longer than needed; align with audit-log retention (minimum 365 days, default about seven years) and tender-record needs. | `audit_retention_days`; purge jobs (roadmap) |
| 10 | **Security measures summary** | Evidence for s19: RLS tenancy, encryption in transit and at rest, Vault for mailbox secrets, MFA, audit trail. | `docs/security.md` |
| 11 | **Breach response plan and register** | s22: notify the Regulator and affected data subjects as soon as reasonably possible; notify customers (as operator) without delay. Roles, templates, contact tree, decision log. | Sentry/alerting (roadmap) |
| 12 | **Director-data attestation** | Directors are third-party data subjects. The customer confirms it has a lawful basis to upload their IDs and share them with TenderOS. | Shown at document upload |
| 13 | **AI processing disclosure** | State that tender documents and company facts are sent to an AI provider; director personal data and bank details are never sent to AI. | Enforced in code (data categories); privacy notice |
| 14 | **Marketing consent** | POPIA s69 / direct marketing: opt-in, separate from transactional email. | Notification preferences |
| 15 | **Cookie notice** | Only essential session cookies today; keep the notice short and accurate. | Footer |
| 16 | **Website disclosures** | ECTA s43 supplier details (name, registration number, address, contact). Confirm whether consumer-protection rules apply to B2B sales. | Footer and checkout (later) |
| 17 | **Security contact and disclosure policy** | A `security.txt` and a mailbox for reports. | `/.well-known/security.txt` |

## Product changes these documents depend on

- Consent record at sign-up with document version and timestamp (planned
  slice S4 in `docs/plans/auth-signup.md`).
- Erasure and export of user and organisation data: built (`erase_user`,
  `erase_organisation`, the exports, the owner's download in Settings), with the
  runbook in `docs/popia-operations.md`. The audit trail is de-identified, not
  deleted, until its retention period ends.
- Retention purge jobs: built (`tenderos-retention-purge`, daily). Breach
  alerting is not (no error reporting yet); the breach plan is in
  `docs/popia-operations.md`. The rule that director personal data never enters
  AI prompts is enforced in code.

## Open points for the attorney

1. Is TenderOS operator, responsible party, or both for each data class?
2. Is the Supabase region plus the AI provider's location acceptable under
   s72 with the agreements in place?
3. PAIA manual: required or exempt?
4. What are the right liability and indemnity terms for AI-assisted bids
   (e.g. an error in an extracted requirement)?
5. Who is the Information Officer, and where is the request mailbox?
6. Retention period for audit logs and consent records after an account is
   deleted.
