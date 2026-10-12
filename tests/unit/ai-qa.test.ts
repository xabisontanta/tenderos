import { describe, expect, it } from "vitest";
import { qaOutputSchema } from "@/agents/qa/schema";
import { qaReviewReal } from "@/agents/qa/real";
import { reviewBid } from "@/agents/qa/logic";
import { ToolNotPermittedError } from "@/agents/runtime/tool-access";
import { FakeAiClient, type FakeReply } from "../support/fake-ai";
import { NOW, makeAi, makeCtx, tender } from "../support/context";

const reqs = [
  { id: "closing", category: "DEADLINE", text: "Closes", mandatory: true, status: "EXTRACTED", source: { kind: "TENDER_RECORD" } },
  { id: "doc-1", category: "MANDATORY_CONDITION", text: "CIDB grade 6CE or higher", mandatory: true, status: "EXTRACTED", source: { kind: "TENDER_DOCUMENT", quote: "hold a valid CIDB grading of 6CE" } },
  { id: "doc-2", category: "DOCUMENT", text: "Submit SBD 1 and a Tax Compliance Status PIN", mandatory: true, status: "EXTRACTED", source: { kind: "TENDER_DOCUMENT", quote: "SBD 1 and a valid Tax Compliance Status PIN" } },
  { id: "doc-3", category: "SCOPE", text: "Rehabilitate 4 km of road", mandatory: false, status: "EXTRACTED", source: { kind: "TENDER_DOCUMENT", quote: "rehabilitation of 4 km of access roads" } },
];

const prior = (o: Record<string, unknown> = {}) => ({
  intake: { tender_id: "t" },
  analysis: { requirements: reqs, documents_analysed: 1, gaps: [], simulated: false, ai_generated: true },
  qualification: { decision: "QUALIFIED", confirmation_required: false, fit_score: 90, factors: [], hard_disqualifiers: [], simulated: false },
  compliance: {
    outcome: "COMPLETE",
    items: [
      { key: "cidb_grading", label: "CIDB grading certificate", category: "CERTIFICATIONS", mandatory: true, status: "VALID", evidence: "Registration 2019/999999/07 SENTINEL", document_id: null },
      { key: "tax_compliance", label: "SARS tax compliance status", category: "TAX", mandatory: true, status: "MISSING_INFORMATION", evidence: "No document on file", document_id: null },
    ],
    missing: ["SARS tax compliance status"],
    simulated: false,
    continued_in_simulation: false,
  },
  proposal: {
    sections: [
      { key: "executive_summary", title: "Executive summary", status: "DRAFTED", content: "Umzansi Civils is a CIDB 6CE contractor.", needs: [] },
      { key: "methodology", title: "Methodology and approach", status: "MISSING_INFORMATION", content: null, needs: ["Company delivery methodology"] },
    ],
    open_items: 1,
    simulated: false,
  },
  pricing: {
    currency: "ZAR",
    vat_rate: 0.15,
    lines: [{ description: "Road rehabilitation", quantity: 4, unit: "km", unit_price_zar: null, source: "MISSING_INFORMATION", requirement_id: "doc-3" }],
    subtotal_zar: null,
    status: "REQUIRES_CONFIRMATION",
    notes: [],
    requires_human_approval: true,
    simulated: false,
  },
  ...o,
});

const cov = (requirement_id: string, result: string, evidence_refs: string[] = [], detail = "x") => ({ requirement_id, result, evidence_refs, detail });
const reply = (coverage: unknown[], inconsistencies: unknown[] = [], other_issues: string[] = []): FakeReply => ({
  json: { coverage, inconsistencies, other_issues },
  usage: { inputTokens: 6000, outputTokens: 700 },
});

function setup(replies: ConstructorParameters<typeof FakeAiClient>[0], p: Record<string, unknown> = prior(), o: { closing?: string; allowedTools?: string[] } = {}) {
  const client = new FakeAiClient(replies);
  const ctx = makeCtx({
    agent: "quality_assurance",
    taskType: "qa.review",
    stepKey: "qa",
    tender: tender(o.closing ? { closing_at: o.closing } : {}),
    previousOutputs: p,
    allowedTools: o.allowedTools,
    ai: makeAi(client, { agent: "quality_assurance" }),
  });
  return { client, ctx };
}

const checkOf = (out: { checks: Array<{ key: string; result: string; detail: string }> }, key: string) => out.checks.find((c) => c.key === key)!;

describe("QA Reviewer (AI)", () => {
  it("declares its needs", () => {
    expect(qaReviewReal).toMatchObject({ taskType: "qa.review", agent: "quality_assurance", tools: ["bid.read"], ai: true });
  });

  it("runs on the HIGH tier and keeps every rule check", async () => {
    const { client, ctx } = setup([reply([cov("doc-1", "ADDRESSED", ["compliance:cidb_grading"])])]);
    const res = await qaReviewReal.run(ctx);
    expect(qaOutputSchema.safeParse(res.output).success).toBe(true);
    expect(client.requests[0].model).toBe("model-high");
    const rules = reviewBid(ctx.tender!, ctx.previousOutputs, NOW);
    for (const c of rules.checks) expect(res.output.checks).toContainEqual(c);
    expect(res.output).toMatchObject({ simulated: false, ai_generated: true });
    expect(res.cost).toMatchObject({ provider: "anthropic", model: "model-high", isSimulated: false });
    expect(res.cost!.costUsd).toBeGreaterThan(0);
  });

  it("passes a requirement only when it cites evidence that is itself complete", async () => {
    const { ctx } = setup([
      reply([
        cov("doc-1", "ADDRESSED", ["compliance:cidb_grading"], "CIDB certificate on file"),
        cov("doc-2", "ADDRESSED", ["compliance:tax_compliance"], "Tax status provided"),
        cov("doc-3", "ADDRESSED", ["section:methodology"], "Methodology covers the scope"),
      ]),
    ]);
    const res = await qaReviewReal.run(ctx);
    expect(checkOf(res.output, "req:doc-1").result).toBe("PASS");
    // The tax document is missing and the methodology section is MISSING_INFORMATION, so the model's claim is not accepted.
    expect(checkOf(res.output, "req:doc-2")).toMatchObject({ result: "OPEN_ISSUE" });
    expect(checkOf(res.output, "req:doc-2").detail).toMatch(/not complete|missing/i);
    expect(checkOf(res.output, "req:doc-3").result).toBe("OPEN_ISSUE");
  });

  it("treats an ADDRESSED claim with no evidence, or evidence that does not exist, as an open issue", async () => {
    const { ctx } = setup([reply([cov("doc-1", "ADDRESSED", []), cov("doc-2", "ADDRESSED", ["section:made_up"])])]);
    const res = await qaReviewReal.run(ctx);
    expect(checkOf(res.output, "req:doc-1").result).toBe("OPEN_ISSUE");
    expect(checkOf(res.output, "req:doc-2").result).toBe("OPEN_ISSUE");
  });

  it("treats a requirement the model did not mention as an open issue, never a pass", async () => {
    const { ctx } = setup([reply([cov("doc-1", "ADDRESSED", ["compliance:cidb_grading"])])]);
    const res = await qaReviewReal.run(ctx);
    expect(checkOf(res.output, "req:doc-2")).toMatchObject({ result: "OPEN_ISSUE" });
    expect(checkOf(res.output, "req:doc-2").detail).toMatch(/not reviewed|could not be determined/i);
  });

  it("never fails a bid on the model's say-so: not addressed is an open issue for the approver", async () => {
    const { ctx } = setup([reply([cov("doc-1", "NOT_ADDRESSED"), cov("doc-2", "CANNOT_DETERMINE"), cov("doc-3", "PARTIALLY_ADDRESSED", ["section:executive_summary"])])]);
    const res = await qaReviewReal.run(ctx);
    expect(res.output.checks.filter((c) => c.key.startsWith("req:")).every((c) => c.result === "OPEN_ISSUE")).toBe(true);
    expect(res.output.verdict).toBe("CONDITIONAL");
    expect(res.output.open_issues.join(" ")).toMatch(/doc-1/);
  });

  it("cannot pass an unconfirmed requirement", async () => {
    const shaky = prior({ analysis: { requirements: [{ ...reqs[1], status: "REQUIRES_CONFIRMATION" }], documents_analysed: 1, gaps: [], simulated: false } });
    const { ctx } = setup([reply([cov("doc-1", "ADDRESSED", ["compliance:cidb_grading"])])], shaky);
    const res = await qaReviewReal.run(ctx);
    expect(checkOf(res.output, "req:doc-1")).toMatchObject({ result: "OPEN_ISSUE" });
    expect(checkOf(res.output, "req:doc-1").detail).toMatch(/unconfirmed/i);
  });

  it("does not call the model, or let it lift a hard failure, when the rules already fail the bid", async () => {
    const missingStep = prior();
    delete (missingStep as Record<string, unknown>).pricing;
    const { client, ctx } = setup([reply([])], missingStep);
    const res = await qaReviewReal.run(ctx);
    expect(res.output.verdict).toBe("FAIL");
    expect(client.requests).toHaveLength(0);
    expect(res.output.ai_note).toMatch(/hard failure/i);
    expect(res.cost).toMatchObject({ provider: "rules", costUsd: 0 });
    expect(res.events?.[0]).toMatchObject({ type: "QA_FAIL", severity: "ERROR" });

    const closed = setup([reply([])], prior(), { closing: "2026-10-01T09:00:00.000Z" });
    expect((await qaReviewReal.run(closed.ctx)).output.verdict).toBe("FAIL");
    expect(closed.client.requests).toHaveLength(0);
  });

  it("can reach PASS only when everything is complete", async () => {
    const complete = prior({
      compliance: { outcome: "COMPLETE", items: [{ key: "cidb_grading", label: "CIDB", category: "CERTIFICATIONS", mandatory: true, status: "VALID", evidence: "x" }], missing: [], simulated: false, continued_in_simulation: false },
      proposal: { sections: [{ key: "executive_summary", title: "Executive summary", status: "DRAFTED", content: "Text.", needs: [] }], open_items: 0, simulated: false },
      pricing: { ...prior().pricing, status: "READY_FOR_APPROVAL" },
    });
    const only = { ...complete, analysis: { requirements: [reqs[1]], documents_analysed: 1, gaps: [], simulated: false } };
    const { ctx } = setup([reply([cov("doc-1", "ADDRESSED", ["compliance:cidb_grading"])])], only);
    const res = await qaReviewReal.run(ctx);
    expect(res.output.verdict).toBe("PASS");
    expect(res.output.open_issues).toEqual([]);
    expect(res.events?.[0]).toMatchObject({ type: "QA_PASS" });
  });

  it("records the model's consistency findings as open issues with only valid references", async () => {
    const { ctx } = setup([
      reply([cov("doc-1", "ADDRESSED", ["compliance:cidb_grading"])], [{ detail: "The proposal claims a 10 week programme but the tender asks for 12 weeks", refs: ["section:executive_summary", "doc-3", "nonsense"] }], ["Signatures are not evidenced"]),
    ]);
    const res = await qaReviewReal.run(ctx);
    const c = res.output.checks.find((x) => x.key === "consistency:1")!;
    expect(c.result).toBe("OPEN_ISSUE");
    expect(c.evidence_refs).toEqual(["section:executive_summary", "doc-3"]);
    expect(res.output.checks.find((x) => x.key === "other:1")).toMatchObject({ result: "OPEN_ISSUE", detail: "Signatures are not evidenced" });
  });

  it("reports an open issue and makes no model call when no document requirements were analysed", async () => {
    const none = prior({ analysis: { requirements: [reqs[0]], documents_analysed: 0, gaps: [], simulated: false } });
    const { client, ctx } = setup([reply([])], none);
    const res = await qaReviewReal.run(ctx);
    expect(client.requests).toHaveLength(0);
    expect(checkOf(res.output, "coverage")).toMatchObject({ result: "OPEN_ISSUE" });
    expect(res.output.verdict).toBe("CONDITIONAL");
    expect(res.output.ai_note).toMatch(/no analysed requirements/i);
  });

  it("sends the model statuses and draft text but not compliance evidence text, and only as data", async () => {
    const { client, ctx } = setup([reply([cov("doc-1", "ADDRESSED", ["compliance:cidb_grading"])])]);
    await qaReviewReal.run(ctx);
    const everything = JSON.stringify(client.requests);
    expect(everything).not.toContain("SENTINEL");
    expect(everything).not.toContain("2019/999999/07");
    expect(everything).toContain("[section:executive_summary]");
    expect(everything).toContain("[compliance:cidb_grading]");
    const blocks = client.requests[0].messages[0].content.filter((b) => b.type === "text" && b.text.startsWith("<<<UNTRUSTED_DATA"));
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(client.requests[0].system).toMatch(/missing information is an open issue/i);
  });

  it("is refused when the tool is not on the agent's list", async () => {
    const { client, ctx } = setup([reply([])], prior(), { allowedTools: [] });
    await expect(qaReviewReal.run(ctx)).rejects.toBeInstanceOf(ToolNotPermittedError);
    expect(client.requests).toHaveLength(0);
  });
});
