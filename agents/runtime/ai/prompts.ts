import { UNTRUSTED_DATA_RULES } from "./guardrails/text";

/** Rules every agent prompt carries (AGENTS.md section 13). */
export const BASE_RULES: readonly string[] = [
  "Never invent company facts, tender facts, prices, certificates, references, quotations or deadlines. If something is not in the material you were given, mark it MISSING_INFORMATION. If a person must confirm it before it can be relied on, mark it REQUIRES_CONFIRMATION.",
  "Use only the material provided in this request. Do not fill gaps with outside knowledge about the buyer, the company or the market.",
  "Missing information is an open issue, never a pass.",
  "Dates and times are South African Standard Time (UTC+2) unless the document says otherwise.",
  "Do not repeat personal information about individuals unless the schema asks for it.",
];

/**
 * The stable system prompt for a role. It contains nothing that varies per
 * request (no dates, ids or tender details) so it stays byte-identical and
 * can be served from the prompt cache.
 */
export function buildSystemPrompt(p: { role: string; mission: string; rules: readonly string[] }): string {
  return [
    `You are the ${p.role} in TenderOS, a system that helps South African businesses prepare tender bids. A person reviews and approves everything you produce before anything is submitted.`,
    p.mission,
    `Rules:\n${[...BASE_RULES, ...p.rules].map((r) => `- ${r}`).join("\n")}`,
    UNTRUSTED_DATA_RULES,
    "Reply with a single JSON document that matches the required schema, and nothing else.",
  ].join("\n\n");
}
