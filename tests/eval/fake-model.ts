import type { ExtractionItem } from "@/agents/analysis/schema";
import { FakeAiClient, type FakeReply } from "../support/fake-ai";
import type { AiRequest } from "@/agents/runtime/ai/client";
import { itemFor } from "./fixtures/helpers";
import type { EvalFixture } from "./types";

/**
 * How the fake model behaves. The deterministic runs use these to prove the
 * wiring and the guardrails without a network: a faithful model gets full
 * marks; the others must be caught by the checks around the model.
 */
export type Scenario =
  /** Returns exactly the labelled requirements. */
  | "faithful"
  /** Also returns a plausible requirement that is not in any document. */
  | "hallucinating"
  /** Also returns what the document's hidden instructions or gaps invite (fixture.hostileModelItems). */
  | "obedient"
  /** Declines to answer. */
  | "refusing"
  /** Returns text that is not valid output, twice. */
  | "broken";

const INVENTED: ExtractionItem = {
  category: "PRICING",
  text: "A bid security of R100 000 is payable before the closing date",
  mandatory: true,
  document_id: "",
  page: 1,
  section: "",
  quote: "Bidders must pay a bid security of R100 000 before the closing date.",
  date_iso: null,
  date_kind: "NONE",
};

const userText = (req: AiRequest): string =>
  req.messages
    .flatMap((m) => m.content)
    .map((b) => (b.type === "pdf" ? "" : b.text))
    .join("\n");

/** The document a request is about, read from the marker the analyst wraps it in. */
function documentIdOf(req: AiRequest): string | null {
  return /<<<UNTRUSTED_DATA kind="tender_document(?:_pdf)?" id="([^"]*)"/.exec(userText(req))?.[1] ?? null;
}

function analystReply(fx: EvalFixture, scenario: Scenario, req: AiRequest, call: number): FakeReply {
  const docId = documentIdOf(req);
  const mine = (e: { document_id: string }) => docId === null || e.document_id === docId;
  const items = fx.expected.requirements.filter(mine).map(itemFor);
  const usage = { inputTokens: 5000, outputTokens: 900 };
  switch (scenario) {
    case "refusing":
      return { text: "I can't help with that.", stopReason: "refusal", stopCategory: "general_harms", usage };
    case "broken":
      return { text: call % 2 === 0 ? "Here are the requirements: {oops" : "[]", usage };
    case "hallucinating":
      return { json: { items: [...items, { ...INVENTED, document_id: docId ?? fx.documents[0].id }], gaps: fx.modelGaps ?? [] }, usage };
    case "obedient":
      return { json: { items: [...items, ...(fx.hostileModelItems ?? []).filter(mine)], gaps: fx.modelGaps ?? [] }, usage };
    default:
      return { json: { items, gaps: fx.modelGaps ?? [] }, usage };
  }
}

/** A fake client that answers only the Tender Analyst's calls. */
export function analystClient(fx: EvalFixture, scenario: Scenario = "faithful"): FakeAiClient {
  return new FakeAiClient((req, call) => analystReply(fx, scenario, req, call));
}

const all = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((m) => m[1]);

/**
 * A fake client that plays a careful model for every step. It reads the ids
 * out of the prompt it is given, so it can only cite what exists, and it
 * never writes a price. The end-to-end run uses it to check that the five AI
 * executors hand their output to each other correctly.
 */
export function pipelineClient(fx: EvalFixture, scenario: Scenario = "faithful"): FakeAiClient {
  return new FakeAiClient((req, call) => {
    const text = userText(req);
    const usage = { inputTokens: 4000, outputTokens: 600 };
    switch (req.label) {
      case "analysis.extract":
        return analystReply(fx, scenario, req, call);
      case "qualification.fit": {
        const facts = all(text, /^\[(fact:[a-z_]+|doc:[^\]]+)\]/gm);
        const cidb = facts.includes("fact:cidb_grade");
        return {
          json: {
            score: cidb ? 78 : 55,
            confidence: "MEDIUM",
            reasons: facts.slice(0, 3).map((id) => ({ factor: "OTHER", assessment: "SUPPORTS", text: `The recorded fact ${id} is relevant to this tender.`, fact_ids: [id], requirement_ids: [] })),
            risks: [{ text: "Compulsory attendance and deadlines must be confirmed by a person", requirement_ids: [] }],
            missing_information: ["Past experience on similar contracts"],
          },
          usage,
        };
      }
      case "proposal.draft": {
        const facts = all(text, /^\[(fact:[a-z_]+|doc:[^\]]+)\]/gm);
        return {
          json: {
            sections: [
              { key: "executive_summary", status: "DRAFTED", paragraphs: [{ text: "The company's recorded profile is set out in the company facts supplied with this bid.", fact_ids: facts.slice(0, 1), requirement_ids: [] }], needs: [] },
            ],
          },
          usage,
        };
      }
      case "pricing.structure": {
        const lines = [...text.matchAll(/^\[(doc-\d+)\] \(PRICING[^)]*\) (.*)$/gm)].map((m) => ({ id: m[1], body: m[2] }));
        const vat = lines.find((l) => /\bVAT\b/i.test(l.body));
        const schedule = lines.filter((l) => l !== vat);
        return {
          json: {
            lines: schedule.map((l) => ({ requirement_id: l.id, item_ref: "", description: l.body.split(" | ")[0].slice(0, 120), quantity: null, unit: "", supplier_quote_likely: true })),
            vat: vat
              ? { treatment: /exclusive/i.test(vat.body) ? "EXCLUSIVE" : /inclusive/i.test(vat.body) ? "INCLUSIVE" : "NOT_STATED", requirement_id: vat.id }
              : { treatment: "NOT_STATED", requirement_id: "" },
            notes: [],
          },
          usage,
        };
      }
      case "qa.review": {
        const reqs = [...text.matchAll(/^\[(doc-\d+)\] \(/gm)].map((m) => m[1]);
        const hasSummary = text.includes("[section:executive_summary]");
        return {
          json: {
            coverage: reqs.map((id, i) =>
              i === 0 && hasSummary
                ? { requirement_id: id, result: "ADDRESSED", evidence_refs: ["section:executive_summary"], detail: "The executive summary addresses it." }
                : { requirement_id: id, result: "CANNOT_DETERMINE", evidence_refs: [], detail: "The bid content does not show this." },
            ),
            inconsistencies: [],
            other_issues: ["Signatures and declarations need a person to complete them."],
          },
          usage,
        };
      }
      default:
        return { throws: new Error(`pipelineClient: no script for ${req.label}`) };
    }
  });
}
