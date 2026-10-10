# Roadmap

Each phase ends with lint, typecheck, tests and a production build passing.

## Milestone 1: foundation and simulated workflow (done)

**Definition.** A signed-in user can create a tender, start a workflow, and
watch real, persisted agent work move it to a simulated submission, with a
human approval in between. Specifically:

| Requirement                                 | Status | Evidence                                                           |
| ------------------------------------------- | ------ | ------------------------------------------------------------------ |
| Login and sign-up                           | done   | e2e test                                                           |
| Dashboard on real data                      | done   | e2e screenshots                                                    |
| Departments and agents with persisted state | done   | registry copied per organisation; status transitions table         |
| Tender creation                             | done   | e2e test                                                           |
| Workflow initiation                         | done   | `start_tender_workflow`; e2e                                       |
| Tasks created and completed per step        | done   | integration test: 9 tasks                                          |
| Live agent events                           | done   | realtime feed; `agent_events`                                      |
| Visual handoffs                             | done   | Office lines on `HANDOFF_CREATED`; Operations graph                |
| Office and Operations reflect real state    | done   | e2e screenshots                                                    |
| Completion hands off to the next agent      | done   | integration test: 9 handoffs, all accepted                         |
| Everything stored in Supabase               | done   | no client-side state is authoritative                              |
| Simulated tender workflow                   | done   | `simulated_bid`, only for tenders flagged simulation               |
| Human approval before submission            | done   | approval gate; reject path tested                                  |
| Failure paths                               | done   | retry, exhaustion, dead-letter, operator retry, pause, kill switch |

## Phase 2: company profile and document vault

Company profile, capabilities, project references, compliance documents
(CIPC, CSD, tax clearance PIN, B-BBEE, CIDB, insurance) with expiry dates;
Supabase Storage with encryption at rest, signed URLs, per-document access
logs. Compliance checks against real documents instead of placeholders.
E2E: upload a company document.

## Phase 3: real AI execution

Provider adapter behind `selectModel`, structured outputs validated by the
existing zod schemas, token and cost tracking into `cost_usage`, budget
enforcement (monthly and per tender), prompt and response logging with
redaction. Simulation mode stays available and remains the default.

## Phase 4: tender ingestion

Upload tender packs (PDF, DOCX), text extraction, requirement extraction with
page references, amendments and briefing notes. Tender Analyst and
Qualification Agent run on real documents.

## Phase 5: discovery connectors

eTenders and other portal connectors behind `TenderSourceConnector`, with
deduplication, scheduling, and the Tender Scout activated.

## Phase 6: bid production

Proposal drafting from verified company data, Forms Agent for SBD/MBD
returnables, pricing schedules with human-entered figures and VAT, QA
against the full requirement set.

## Phase 7: approvals and submission

Multi-step approvals (pricing, declarations, final), e-signatures, electronic
submission where portals allow it, with proof of submission. Still no
auto-submission.

## Phase 8: team and operations

Invitations and member management, MFA, notifications by email, Sentry,
alerting, budget dashboards, data retention jobs.

## Phase 9: communications and learning

Inbox integration (clarifications, briefing notices, award letters),
outcome tracking, win/loss analysis, Intelligence Analyst.

## Known gaps in milestone 1

- Editing settings (budgets, simulation mode) is read-only in the UI.
- The six inactive agents have no executors yet.
- Monthly and per-tender budgets are stored but not enforced.
- No document upload; the e2e step "upload company document" moves to Phase 2.
