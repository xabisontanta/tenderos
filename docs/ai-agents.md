# AI agents

How the model-backed executors work, what each agent really does, and what
stops it from making things up. `AGENTS.md` holds the binding rules; this file
explains how they are met. The provider is Anthropic.

## Modes

| Mode                 | When                                      | Executors                                    | Cost recorded                             |
| -------------------- | ----------------------------------------- | -------------------------------------------- | ----------------------------------------- |
| Simulation           | The tender is flagged simulation          | `simulated.ts`                               | $0, `is_simulated = true`                 |
| Rules only (default) | A real tender, AI off                     | `simulated.ts` rules                         | $0, provider `rules`                      |
| AI                   | A real tender, AI on for the organisation | `real.ts` for five steps, rules for the rest | Real tokens and USD, provider `anthropic` |

AI is opt-in, with two switches that must both be on. `AI_ENABLED=true` in the
worker's environment is the deployment's kill switch. `system_settings.ai_enabled`
is the organisation's own switch: an owner or admin sets it in Settings, AI
assistance (`set_ai_settings`), after ticking that they have read what is sent to
Anthropic and that it is processed outside South Africa. The database refuses to
switch it on while the daily AI budget is zero (the engine reads zero as no
limit), asks for a second factor when the organisation requires one, rate limits
the change and audits it. Simulation runs never reach a model. Compliance, the Director and the
Submission Officer stay rule-based in every mode.

`getExecutor(taskType, { simulation, aiEnabled })` in `agents/index.ts` picks
the executor.

## One AI step, start to finish

1. **Before the task starts** the engine loads the AI configuration. A missing
   `ANTHROPIC_API_KEY`, a missing model for the agent's tier or a missing price
   fails the task at once with the variable named (nothing falls back to rules,
   to another tier or to a default price). It also caps the task at what is left
   of the organisation's daily AI budget.
2. **The executor** reads what it is allowed to read, using only tools on the
   agent's stored allow-list (`ctx.tools`). A refused tool fails the task and
   writes a `TOOL_REFUSED` WARNING event.
3. **The prompt** is built only through `buildPrompt`, which enforces the data
   policy, wraps third-party text as data and rejects anything prohibited.
4. **`generateStructured`** picks the model with `selectModel`, counts the
   prompt's tokens (refusing an oversize prompt or a call the task budget cannot
   cover), calls the API, validates the JSON with zod and the executor's own
   checks, and allows one repair attempt that replays the exchange and lists
   what was wrong. After that it fails with a non-retryable error.
5. **The executor** checks the model's claims against its sources (quotes,
   cited ids, figures), downgrades or removes what it cannot support, and
   returns the output with `ai_generated: true` and a cost record.
6. **The engine** validates the output against the stored schema, records the
   cost in `cost_usage` and on the task, and continues the workflow. If the
   step fails, the money already spent is still recorded.

## Configuration

See `.env.example`. In hosted Supabase set the same names as Edge Function
secrets (`supabase secrets set ANTHROPIC_API_KEY=...`).

| Variable                                            | Meaning                                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                 | Required for AI. Held in a non-enumerable property so it cannot reach a log line or JSON.                       |
| `AI_ENABLED`                                        | The deployment's kill switch: AI runs only when this is `true` and the organisation's own switch is on.         |
| `AI_MODEL_LOW` / `MID` / `HIGH`                     | The model for each cost tier. No model name is in the code.                                                     |
| `AI_PRICE_LOW` / `MID` / `HIGH`                     | USD per million tokens, `input/output[/cacheRead[/cacheWrite]]`. Required: it is how cost is computed.          |
| `AI_PRICE_OVERRIDE`                                 | Price for an agent's `model_override`.                                                                          |
| `AI_EFFORT_LOW` / `MID` / `HIGH`                    | Optional thinking effort per tier.                                                                              |
| `AI_TIMEOUT_MS`, `AI_MAX_ATTEMPTS`                  | Per-request timeout and tries (default 120000 and 3).                                                           |
| `AI_MAX_INPUT_TOKENS`                               | A prompt over this is refused (default 100000, which also keeps the cheapest tier under its long-prompt price). |
| `AI_MAX_OUTPUT_TOKENS`, `AI_CHUNK_CHARS`            | Output ceiling per call and the size of a document part.                                                        |
| `AI_MAX_TASK_COST_USD`                              | A task that has spent this starts no further call (default 2).                                                  |
| `AI_HIGH_VALUE_ZAR`                                 | Tenders at or above this value move up one tier.                                                                |
| `AI_WEB_RESEARCH_ENABLED`, `AI_WEB_SEARCH_COST_USD` | `false` vetoes web research for the whole deployment; the per-search cost.                                      |

Models confirmed against the `claude-api` skill and Anthropic's pricing page
on 2026-10-12: LOW `claude-haiku-5-5` ($0.10 / $0.50 per million tokens, for
prompts up to 100,000 tokens), MID `claude-sonnet-5-5` ($2 / $10), HIGH
`claude-opus-5-5` ($4 / $20). Prompt cache reads cost $0.01, $0.10 and $0.20
per million tokens respectively. Web search is $10 per 1,000 searches.

How the API is called, and why:

- `client.messages.stream(...).finalMessage()`, so long structured answers do
  not hit HTTP timeouts. The SDK's own retries are off (`maxRetries: 0`); the
  client retries 429, 5xx including 529 overloaded, 408/409 and connection
  failures with exponential backoff and jitter, honours `retry-after`, and stops
  when the task's abort signal fires. Other 4xx fail at once without a retry.
- `output_config.format` with a JSON Schema generated by `z.toJSONSchema` and
  rewritten to the subset the API accepts (`agents/runtime/ai/schema.ts`). A
  schema over the documented limits (24 optional properties, 16 `anyOf`) fails in
  our code, not at the API. Forced `tool_choice` is not used (a 400 on the
  Sonnet 5.5 and Opus 5.5 models), and no sampling parameters, thinking budget
  or prefill are sent.
- The system prompt is marked for prompt caching, as are the large stable
  blocks (tender record, document part, company facts), so the repair call
  re-reads them from the cache. System prompts hold nothing that varies per
  request.
- `count_tokens` before every call, for the input limit and the budget check.
- A `refusal` stop reason is a clean, non-retryable failure that needs a person.
  The server-side `fallbacks` parameter is not sent: models are configuration,
  and the parameter is not accepted by every model (Haiku 5.5 rejects it).
- PDFs go as base64 `document` blocks. API citations cannot be combined with
  structured output, so quotes are checked by us (below).

## The agents

### Tender Analyst

**Job.** Read the tender documents and list what a bidder must do and provide.

**Input.** The tender record and the documents from a `DocumentSource` (text per
page, plain text, or a PDF). In production the source is the tender's fetched
PDFs (see "Tender documents" below), each sent as a PDF document block; the
source also hands over one gap sentence per document it knew of but did not
give (a file that failed, a Word file, a document left out of a large pack).
Large documents are split into parts that each fit one request, and the tier
moves up for big packs or high-value tenders.

**Output.** `requirements` (category, text, mandatory, status, and for document
items the `quote`, `page` or `section`, `quote_verified`, optional `date_iso`
and `warning`), `gaps`, `documents_analysed`, `injection_warnings`. Categories
cover eligibility (`MANDATORY_CONDITION`), returnables (`DOCUMENT`), evaluation
(`EVALUATION`), dates (`DEADLINE`, `BRIEFING`), submission, scope and pricing
including each bill-of-quantities line. The tender-record requirements stay.

**Guardrails.**

- A requirement is `EXTRACTED` only if its quote occurs in the text the model was
  given and it has a page or section. Otherwise it is kept as
  `REQUIRES_CONFIRMATION` with the reason, counted in a gap, and reported in an
  `AI_CITATIONS_DOWNGRADED` event. A wrong page is corrected to the real one.
- A PDF is read as a document block, with no extracted text, so every item from
  it is `REQUIRES_CONFIRMATION`: there is no text to check a quote against.
  Fetched tender documents are all in this position until text extraction is
  added (it needs a PDF library, which this release does not have).
- Dates are compared with the tender record and with each other. A conflict is
  reported and every involved item (and the record's own requirement) goes to
  `REQUIRES_CONFIRMATION`; the analyst never picks a date.
- No verified list of required documents, or no verified evaluation criteria, is
  a gap, not a guess.
- Instruction-like text in a document is reported and a quote that overlaps its
  line is never trusted.

**Failure.** A refusal, an output that fails validation after one repair, a
budget stop before anything was read or a refused tool fails the task without a
retry. A part that is too large, a PDF the service rejects (too many pages,
damaged) and a document that would take the task past its cost ceiling are
reported as gaps and the rest is analysed; if nothing can be read the task
fails.

### Tender documents (`lib/tender-documents/`)

The eTenders feed lists each tender's documents (`tenders.documents`). A worker job
`tender.documents.fetch` downloads them into the private `tender-documents` bucket
(`<organisation_id>/<tender_id>/<sha256>.pdf`) and records each on
`tender_documents` with a status: `PENDING`, `DOWNLOADED`, `FAILED`,
`UNSUPPORTED` (Word, Excel, zip and other types, password-protected PDFs, a copy
of a file already held), `TOO_LARGE`. The tender page has a Documents tab with
the status of each and Fetch / Retry.

- **When.** Discovery queues the job when it stores or refreshes a tender that
  has document links, only for organisations that have AI assistance on (a scan
  can store hundreds of tenders and the files are of no use without AI). A
  person with the operator role or above can always press **Fetch documents**
  (`fetch_tender_documents`: rate limited, audited, second factor when required).
  The Tender Analyst also makes sure its tender's documents are fetched before it
  reads them, once per tender at a time (an advisory lock), so a bid that starts
  right after a scan does not read an empty pack.
- **The fetcher** (`fetcher.ts`, `policy.ts`, `transport.ts`) takes https links
  only, to the tender's own host or `TENDER_DOCUMENT_HOSTS` (default
  `www.etenders.gov.za`); no credentials, ports or address literals; resolves the
  name itself and refuses any private, loopback, link-local, metadata or
  reserved address (`lib/security/public-address.ts`, shared with the SMTP
  host check); connects to the checked address; follows redirects by hand, same
  host and https only, checking again on every hop; sends no cookies and refuses
  compression; one 30 s deadline; stops at 25 MB. Only discovery writes
  `tenders.documents`, so a member cannot make the worker fetch an arbitrary URL.
- **Content** is decided by the bytes, not the name (`sniff.ts`): a file named
  `.pdf` that is an HTML error page is `FAILED`, not stored. Only PDFs are stored
  and read. Document text and links never reach the log or an event; the stored
  error is a sentence that does not repeat the URL.
- **What the Analyst gets** (`source.ts`, `select.ts`): the tender's `DOWNLOADED`
  PDFs as PDF blocks, up to 8 documents and 40 MB per tender, in a fixed order
  (invitation and bid documents, then scope and price schedules, then the rest,
  then drawings and photos; ties by file name, then id). A PDF over 18 MB or
  with more than 100 pages is not sent. Every document not read, whatever the
  reason, is a gap in the analysis.
- **Erasure.** Erasing an organisation removes its folder in both buckets before
  the rows go (`lib/privacy/erasure.ts`).

### Qualification Agent

**Job.** The rule gates (48 hours to prepare, a compulsory briefing not missed,
contract size against the exposure limit) decide. For a tender that passes them,
add a drafted fit assessment against the company profile.

**Input.** The tender record, the requirements from the analysis step, and
allow-listed company facts (names, CIDB grade, B-BBEE level, provinces, sectors,
keywords, verified in-date certification and reference documents). The profile
has no past-experience field yet, so experience stays unknown unless a verified
reference document supplies it; the assessment says so in `missing_information`.

**Output.** The unchanged rule result plus `ai_fit`: a score, confidence, reasons
(each citing company fact ids and requirement ids), risks and the missing
information. A factor `ai_fit` is added for display; it is never a hard
disqualifier and low confidence asks for confirmation instead of a verdict.

**Guardrails.** A failed gate never reaches the model and no score can override
it. `SUPPORTS` must cite a fact that exists; cited ids that do not exist send the
answer back for repair. With no capability facts there is no call and the factors
stay `REQUIRES_CONFIRMATION`.

### Proposal Writer

**Job.** Draft the six outline sections for a person to review.

**Input.** The tender record, the analysed requirements and the same company
facts. Titles come from a fixed outline; the model cannot rename or add sections.

**Output.** Sections with `status`, `content`, `needs`, and the `paragraphs`
behind the content, each with the fact ids and requirement ids it rests on.
`ai_generated: true`.

**Guardrails.** Every paragraph must cite something that exists (otherwise
repaired, then the task fails). A paragraph whose figures (years, counts,
grades, standards) appear in neither the facts nor the requirements is removed
and reported. A section with no supported text is `MISSING_INFORMATION` with its
`needs`; a section is `DRAFTED` only if the model says so, nothing was removed
and nothing is still needed. With no company facts the executor makes no call
and returns the outline, all `MISSING_INFORMATION`.

### Pricing Analyst

**Job.** Structure the pricing schedule from the analysis; never price it.

**Input.** The `PRICING` requirements from the analysis step, with the tender's
printed line for each.

**Output.** `lines` (one per requirement, with the quantity and unit as printed,
the quote and page, `supplier_quote_likely`), `vat` (treatment and status), notes
and the 15% rate. Every `unit_price_zar` is null, `source` is
`MISSING_INFORMATION`, `subtotal_zar` is null, the status is
`REQUIRES_CONFIRMATION` and human approval is required.

**Guardrails.** The model's schema has no price field (a test checks the schema
for the words price, rate, amount, total and cost), and any extra field it sends
is dropped. A quantity survives only if the printed line contains it. A VAT
treatment survives only if a requirement that mentions VAT backs it; otherwise
it is `NOT_STATED` and flagged. Lines come from requirements the analysis
already quoted, so nothing is created from nothing. No schedule lines in the
analysis means no call.

### QA Reviewer (HIGH tier)

**Job.** An independent completeness and consistency review before the approval
gate.

**Input.** The rule checks' inputs plus the requirements, the proposal sections
(status and draft text), the compliance checklist (statuses only) and the
pricing schedule.

**Output.** The existing checks, plus `req:<id>` coverage checks, `consistency:`
findings and `other:` findings. The verdict is computed over all of them.

**Guardrails.** A hard failure in the rule checks ends the review. A requirement
passes only if the requirement is itself confirmed, the model says `ADDRESSED`,
and the content it cites exists and is complete (a drafted section, a valid
compliance item, a priced schedule). A requirement the model did not mention, or
cites nothing for, or cites incomplete content for, is an open issue. The model
cannot produce a `FAIL` and cannot remove an issue. No analysed requirements is
itself an open issue.

### Web research (Scout and Intelligence Analyst)

`researchWeb` (`agents/runtime/ai/web-research.ts`) uses Anthropic's
`web_search_20260209` server tool (confirmed in the `claude-api` skill). It
needs `web.search` on the agent's allowed tools and the organisation's web
research switch; either refusal is logged as a WARNING. The question must not
carry company or personal data. Every answer carries source URLs and an answer
with none is discarded. The search tool needs a Sonnet or Opus model, so a
LOW-tier agent is moved to MID for it. No workflow step calls it yet.

## What the guardrails do not do

- Quote checking proves a quote is in the document, not that the model read it
  correctly. A person still reads the list.
- Injection detection is a pattern list. It catches the usual phrasing and the
  line around it, not every possible attack. The structural defences (data
  markers, no tools that change anything, a person approving every submission)
  carry the weight.
- Figure grounding catches invented numbers, not invented words.
- A PDF cannot be verified until text is extracted from it, so every requirement
  taken from a fetched tender document is `REQUIRES_CONFIRMATION` and QA counts
  it as an open issue until a person has confirmed it.

## Failure behaviour

| What happened                               | Result                                                            |
| ------------------------------------------- | ----------------------------------------------------------------- |
| AI configuration missing                    | Task fails before it starts, no retry, variable named             |
| Tool not on the allow-list, or switched off | Task fails, no retry, `TOOL_REFUSED` WARNING                      |
| Prompt would carry prohibited data          | `PromptPolicyError`, no retry, nothing sent                       |
| Prompt over the input limit                 | Refused before the call                                           |
| Task over its cost ceiling                  | No further call, `AiBudgetError`, no retry                        |
| 429, 5xx, 529, connection failure           | Retried in the client with backoff; then a retryable task failure |
| 400, 401, 403, 404, 413                     | `AiRequestError`, no retry                                        |
| Refusal                                     | `AiRefusalError`, no retry, needs a person                        |
| Cut off at the token limit                  | `AiOutputError`, no retry                                         |
| Invalid output                              | One repair; then `AiOutputError`, no retry                        |
| Task timeout                                | The abort signal stops the call; retried at task level            |

Spend from every call, including failed attempts, is recorded.

## Evaluation

`tests/eval/` holds 12 invented South African tenders (construction with CIDB,
IT services, cleaning, security, medical supplies, municipal, education,
electrical) including adversarial ones: instructions hidden for an AI, a
returnables annexure that was never supplied, two different closing dates, and
a PDF with no text layer.

- **In CI.** `npm run test:unit` runs a deterministic fake model
  (`tests/eval/fake-model.ts`) through the real executors. Scenarios: a
  faithful model (full marks), one that invents a requirement, one that obeys
  the document, one that refuses and one that returns invalid output. A second
  fake plays a careful model for all five steps so the hand-offs are exercised,
  and checks that nothing is priced, nothing sensitive is sent, QA never passes a
  bid with missing information, and cost is reported. This proves the wiring and
  the guardrails; it does not measure the model.
- **Live.** `npm run eval:live` runs the fixtures against the real API and
  prints a report: recall of the labelled requirements, forbidden content that got
  through, unverified items, expected gaps, injection reporting, tokens, cost and
  time. It does nothing, and costs nothing, unless `ANTHROPIC_API_KEY` is set.
  Settings: `EVAL_FIXTURES` (ids), `EVAL_MAX_USD` (stop after this spend, default
  5), `EVAL_MIN_RECALL` (default 0.8), `EVAL_PIPELINE=true` (all five steps),
  `EVAL_STRICT=true` (exit 1 on a failing fixture).

### Fixture format

A fixture is a TypeScript object (`tests/eval/types.ts`):

```ts
interface EvalFixture {
  id: string; // unique, used in reports and EVAL_FIXTURES
  title: string;
  description: string;
  tags: EvalTag[]; // sector:* and adversarial:*
  tender: Partial<TenderSnapshot>; // overrides on a default tender record
  documents: TenderDocument[]; // pages with text, plain text, or a PDF
  groundTruth?: { document_id: string; text: string }; // PDF-only: what the scan says
  company: "civils" | "it" | "facilities" | "medical" | null; // profile for the later steps
  expected: {
    requirements: ExpectedRequirement[];
    forbidden: { pattern: string; why: string }[]; // no EXTRACTED requirement may match
    gaps: string[]; // substrings that must appear in the analysis gaps
    injectionDetected: boolean; // instruction-like text must (or must not) be reported
    qualification: { decision: "QUALIFIED" | "REJECTED" }; // the rule-gate outcome
  };
  modelGaps?: string[]; // gaps a faithful model reports itself
  hostileModelItems?: ExtractionItem[]; // what a model that obeys the document also returns
}

interface ExpectedRequirement {
  key: string; // stable label
  category: "DEADLINE" | "BRIEFING" | "SUBMISSION" | "MANDATORY_CONDITION" | "DOCUMENT" | "SCOPE" | "PRICING" | "EVALUATION";
  mandatory: boolean;
  document_id: string;
  page: number | null; // null for text without pages
  section: string; // needed when there is no page
  quote: string; // verbatim from the document; a unit test checks it
  textIncludes: string[]; // one must appear in the extracted text
  date?: { kind: "CLOSING" | "BRIEFING" | "QUESTIONS"; iso: string };
  status: "EXTRACTED" | "REQUIRES_CONFIRMATION"; // what the analyst must give it
}
```

A fixture passes when recall of the labelled requirements (with the expected
status) meets the bar, no forbidden pattern appears in an `EXTRACTED`
requirement, every expected gap phrase is present, no `EXTRACTED` requirement
has an unverified quote, and instruction-like text is reported exactly when
expected. To add one, copy a fixture, build the document lines and the labelled
quotes from the same constants (so they cannot drift), and add it to
`tests/eval/fixtures/index.ts`. The structural test checks the quotes.

## Operating notes

- Watch the `ai.call` log lines: `outcome` (`ok`, `invalid`, `refused`,
  `truncated`, `error`), `cost_usd`, `usage.cache_read` (zero across repeated
  calls means something is invalidating the cache), `latency_ms`.
- A budget stop shows as a `BUDGET_WARNING` event; a refused tool as
  `TOOL_REFUSED`; downgraded quotes as `AI_CITATIONS_DOWNGRADED`; hidden
  instructions as `PROMPT_INJECTION_SUSPECTED`.
- The Edge worker loads the SDK through `npm:@anthropic-ai/sdk` (pinned to the
  installed version by `scripts/build-edge-worker.mjs`). Rebuild with
  `npm run build:edge-worker` after changing the SDK version.
- Not built yet: text extraction from PDFs (so quotes can be verified), reading
  Word, Excel and zip files, proposal and pricing editing screens, ZAR cost
  display, monthly and per-tender budgets, and a workflow step that calls web
  research.
- A document the portal lists but TenderOS could not fetch shows on the tender's
  Documents tab with the reason; the job's own failures show in the worker log
  (`tender document not fetched`, with the reason and no link).
