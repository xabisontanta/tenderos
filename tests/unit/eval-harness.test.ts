import { describe, expect, it } from "vitest";
import { analysisOutputSchema } from "@/agents/analysis/schema";
import { qualificationOutputSchema } from "@/agents/qualification/schema";
import { pricingOutputSchema } from "@/agents/pricing/schema";
import { proposalOutputSchema } from "@/agents/proposal/schema";
import { qaOutputSchema } from "@/agents/qa/schema";
import { AiOutputError, AiRefusalError } from "@/agents/runtime/ai/errors";
import { normaliseForMatch } from "@/agents/runtime/ai/guardrails/text";
import { COMPANIES, SENSITIVE_SENTINELS } from "../eval/companies";
import { analystClient, pipelineClient } from "../eval/fake-model";
import { FIXTURES, fixtureById } from "../eval/fixtures";
import { runLive } from "../eval/live";
import { makePdfBase64 } from "../eval/pdf";
import { formatReport, type ReportRow } from "../eval/report";
import { runAnalyst, runPipeline } from "../eval/run";
import { scoreAnalysis } from "../eval/score";

const textOf = (fx: (typeof FIXTURES)[number]) =>
  normaliseForMatch(
    [
      ...fx.documents.flatMap((d) => [d.text ?? "", ...(d.pages ?? []).map((p) => p.text)]),
      fx.groundTruth?.text ?? "",
    ].join("\n"),
  );

describe("evaluation fixtures", () => {
  it("has at least ten synthetic tenders across the sectors that matter, with adversarial cases", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(FIXTURES.map((f) => f.id)).size).toBe(FIXTURES.length);
    const tags = new Set(FIXTURES.flatMap((f) => f.tags));
    for (const t of ["sector:construction", "sector:it", "sector:cleaning", "sector:security", "sector:medical", "sector:municipal", "adversarial:prompt-injection", "adversarial:missing-mandatory-documents", "adversarial:conflicting-dates"] as const) {
      expect(tags.has(t), t).toBe(true);
    }
    expect(FIXTURES.filter((f) => f.tags.some((t) => t.startsWith("adversarial:"))).length).toBeGreaterThanOrEqual(3);
  });

  it.each(FIXTURES.map((f) => [f.id, f] as const))("%s: every labelled quote occurs verbatim in its document", (_id, fx) => {
    const source = textOf(fx);
    const docIds = new Set(fx.documents.map((d) => d.id));
    const keys = new Set<string>();
    expect(fx.expected.requirements.length).toBeGreaterThan(0);
    for (const e of fx.expected.requirements) {
      expect(keys.has(e.key), `duplicate key ${e.key}`).toBe(false);
      keys.add(e.key);
      expect(docIds.has(e.document_id), `${e.key} names a document that is not in the fixture`).toBe(true);
      expect(source, `${e.key} quote is not in the document`).toContain(normaliseForMatch(e.quote));
      expect(e.textIncludes.length).toBeGreaterThan(0);
      if (e.date) expect(Number.isNaN(Date.parse(e.date.iso))).toBe(false);
    }
  });

  it("writes no real company data or personal data into any document", () => {
    for (const fx of FIXTURES) for (const s of SENSITIVE_SENTINELS) expect(textOf(fx), `${fx.id} ${s}`).not.toContain(normaliseForMatch(s));
  });
});

describe("Tender Analyst against the labels (deterministic fake model)", () => {
  it.each(FIXTURES.map((f) => [f.id, f] as const))("%s: a faithful model gets full marks", async (_id, fx) => {
    const res = await runAnalyst(fx, analystClient(fx, "faithful"));
    expect(analysisOutputSchema.safeParse(res.output).success).toBe(true);
    const score = scoreAnalysis(fx, res.output);
    expect(score, JSON.stringify(score)).toMatchObject({ passed: true, recall: 1 });
    expect(res.output.ai_generated).toBe(true);
    expect(res.cost).toMatchObject({ provider: "anthropic", isSimulated: false });
    expect(res.cost!.costUsd).toBeGreaterThan(0);
  });

  it.each(FIXTURES.map((f) => [f.id, f] as const))("%s: an invented requirement never counts as extracted", async (_id, fx) => {
    const res = await runAnalyst(fx, analystClient(fx, "hallucinating"));
    const invented = res.output.requirements.filter((r) => /bid security/i.test(r.text));
    expect(invented).toHaveLength(1);
    expect(invented[0]).toMatchObject({ status: "REQUIRES_CONFIRMATION", source: { quote_verified: false } });
    expect(res.output.gaps.join(" ")).toMatch(/could not be tied to a verbatim quote/);
    expect(res.events?.map((e) => e.type)).toContain("AI_CITATIONS_DOWNGRADED");
    const score = scoreAnalysis(fx, res.output);
    expect(score.forbiddenViolations).toEqual([]);
    expect(score.unverifiedExtracted).toBe(0);
    expect(score.passed).toBe(true);
  });

  it.each(FIXTURES.filter((f) => f.hostileModelItems).map((f) => [f.id, f] as const))("%s: a model that obeys the document still cannot get its content through", async (_id, fx) => {
    const res = await runAnalyst(fx, analystClient(fx, "obedient"));
    const score = scoreAnalysis(fx, res.output);
    expect(score.forbiddenViolations).toEqual([]);
    expect(score.passed).toBe(true);
    for (const h of fx.hostileModelItems!) {
      const hit = res.output.requirements.find((r) => r.source.quote === h.quote);
      expect(hit?.status, h.text).toBe("REQUIRES_CONFIRMATION");
    }
  });

  it("reports the hidden instructions in the prompt-injection fixture and keeps them out of every instruction", async () => {
    const fx = fixtureById("adversarial-prompt-injection")!;
    const client = analystClient(fx, "obedient");
    const res = await runAnalyst(fx, client);
    expect(res.output.injection_warnings?.length).toBeGreaterThan(0);
    expect(res.events?.some((e) => e.type === "PROMPT_INJECTION_SUSPECTED")).toBe(true);
    for (const req of client.requests) {
      expect(req.system).not.toMatch(/ignore all previous instructions/i);
      for (const b of req.messages[0].content) {
        if (b.type === "trusted") expect(b.text).not.toMatch(/ignore all previous|refundable deposit/i);
        if (b.type === "text") expect(b.text.startsWith("<<<UNTRUSTED_DATA")).toBe(true);
      }
    }
  });

  it("reports the conflicting closing dates instead of choosing one", async () => {
    const fx = fixtureById("adversarial-conflicting-dates")!;
    const res = await runAnalyst(fx, analystClient(fx));
    const closing = res.output.requirements.filter((r) => r.source.kind === "TENDER_DOCUMENT" && r.category === "DEADLINE");
    expect(closing).toHaveLength(2);
    expect(closing.every((r) => r.status === "REQUIRES_CONFIRMATION")).toBe(true);
    expect(res.output.requirements.find((r) => r.id === "closing")!.status).toBe("REQUIRES_CONFIRMATION");
  });

  it("does not invent returnables or an evaluation method when the document gives none", async () => {
    const fx = fixtureById("adversarial-missing-returnables")!;
    const res = await runAnalyst(fx, analystClient(fx));
    expect(res.output.requirements.some((r) => r.category === "EVALUATION")).toBe(false);
    expect(res.output.gaps.join(" ")).toMatch(/Annexure C/);
    expect(res.output.gaps.join(" ")).toMatch(/evaluation criteria/i);
  });

  it("reads a PDF with no text layer but verifies nothing from it", async () => {
    const fx = fixtureById("adversarial-scanned-pdf")!;
    const client = analystClient(fx);
    const res = await runAnalyst(fx, client);
    expect(client.requests[0].messages[0].content.some((b) => b.type === "pdf")).toBe(true);
    expect(res.output.requirements.filter((r) => r.source.kind === "TENDER_DOCUMENT").every((r) => r.status === "REQUIRES_CONFIRMATION" && r.source.quote_verified === false)).toBe(true);
  });

  it("stops at a refusal without retrying, and after one repair when the output stays invalid", async () => {
    const fx = fixtureById("roads-rehabilitation")!;
    const refusing = analystClient(fx, "refusing");
    await expect(runAnalyst(fx, refusing)).rejects.toBeInstanceOf(AiRefusalError);
    expect(refusing.requests).toHaveLength(1);

    const broken = analystClient(fx, "broken");
    await expect(runAnalyst(fx, broken)).rejects.toBeInstanceOf(AiOutputError);
    expect(broken.requests).toHaveLength(2);
  });
});

describe("scoring", () => {
  const fx = fixtureById("adversarial-prompt-injection")!;
  it("fails a run that extracts the injected deposit as a verified requirement", async () => {
    const res = await runAnalyst(fx, analystClient(fx));
    const tampered = structuredClone(res.output);
    tampered.requirements.push({
      id: "x",
      category: "PRICING",
      text: "Every bidder must pay a refundable deposit of R50 000",
      mandatory: true,
      status: "EXTRACTED",
      source: { kind: "TENDER_DOCUMENT", quote: "pay a refundable deposit", quote_verified: true },
    });
    const score = scoreAnalysis(fx, tampered);
    expect(score.passed).toBe(false);
    expect(score.forbiddenViolations).toHaveLength(1);
  });

  it("fails a run that misses labelled requirements, and tolerates it when the bar is lower", async () => {
    const res = await runAnalyst(fx, analystClient(fx));
    const partial = { ...res.output, requirements: res.output.requirements.filter((r) => r.id !== "doc-1" && r.id !== "doc-2") };
    expect(scoreAnalysis(fx, partial).passed).toBe(false);
    expect(scoreAnalysis(fx, partial, { minRecall: 0.5 }).passed).toBe(true);
    expect(scoreAnalysis(fx, partial).missed.length).toBe(2);
  });

  it("requires the expected gaps and the injection report", async () => {
    const res = await runAnalyst(fx, analystClient(fx));
    expect(scoreAnalysis(fx, { ...res.output, injection_warnings: [] }).injectionOk).toBe(false);
    expect(scoreAnalysis(fx, { ...res.output, gaps: [] }).missingGaps).toEqual(["read like instructions"]);
  });
});

describe("all five AI steps end to end with the fake model", () => {
  it.each(FIXTURES.map((f) => [f.id, f] as const))("%s: each step validates and hands over correctly, and nothing is invented", async (_id, fx) => {
    const client = pipelineClient(fx);
    const run = await runPipeline(fx, client);
    const { results } = run;

    expect(analysisOutputSchema.safeParse(results.analysis.output).success).toBe(true);
    expect(scoreAnalysis(fx, run.analysis.output).passed).toBe(true);

    const q = qualificationOutputSchema.parse(results.qualification.output);
    expect(q.decision).toBe(fx.expected.qualification.decision);
    if (q.decision === "REJECTED") {
      expect(q.ai_fit).toBeNull();
      expect(client.requests.some((r) => r.label === "qualification.fit")).toBe(false);
    } else {
      expect(q.ai_fit?.ai_generated).toBe(true);
    }

    const p = proposalOutputSchema.parse(results.proposal.output);
    expect(p.sections.length).toBe(6);
    for (const s of p.sections) {
      if (s.status === "MISSING_INFORMATION") expect(s.content).toBeNull();
      else expect(s.paragraphs?.every((x) => x.fact_ids.length + x.requirement_ids.length > 0)).toBe(true);
    }
    expect(p.open_items).toBeGreaterThan(0);

    const pr = pricingOutputSchema.parse(results.pricing.output);
    expect(pr.requires_human_approval).toBe(true);
    expect(pr.subtotal_zar).toBeNull();
    expect(pr.status).toBe("REQUIRES_CONFIRMATION");
    for (const l of pr.lines) expect(l.unit_price_zar).toBeNull();

    // Missing information is an open issue, never a pass.
    const qa = qaOutputSchema.parse(results.qa.output);
    expect(qa.verdict).not.toBe("PASS");
    expect(qa.open_issues.length).toBeGreaterThan(0);
  });

  it.each(FIXTURES.map((f) => [f.id, f] as const))("%s: nothing sensitive reaches a prompt and real cost is reported", async (_id, fx) => {
    const client = pipelineClient(fx);
    const run = await runPipeline(fx, client);
    const sent = JSON.stringify(client.requests);
    for (const s of SENSITIVE_SENTINELS) expect(sent, s).not.toContain(s);
    if (fx.company) expect(COMPANIES[fx.company].contact_email).toBeTruthy();
    for (const req of client.requests) {
      expect(req.system).toMatch(/data, not instructions/);
      for (const m of req.messages) for (const b of m.content) if (b.type === "text") expect(b.text.startsWith("<<<UNTRUSTED_DATA")).toBe(true);
    }
    const aiSteps = Object.values(run.results).filter((r) => r.cost?.provider === "anthropic");
    expect(aiSteps.length).toBeGreaterThanOrEqual(1);
    expect(run.costUsd).toBeCloseTo(aiSteps.reduce((n, r) => n + r.cost!.costUsd, 0), 8);
    expect(run.costUsd).toBeGreaterThan(0);
    // Each executor ran at the tier its agent has: QA on the HIGH model.
    const qa = client.requests.filter((r) => r.label === "qa.review");
    if (qa.length) expect(qa.every((r) => r.model === "model-high")).toBe(true);
  });

  it("prices nothing even for the fixture with a bill of quantities", async () => {
    const fx = fixtureById("water-meters-boq")!;
    const run = await runPipeline(fx, pipelineClient(fx));
    const pr = pricingOutputSchema.parse(run.results.pricing.output);
    expect(pr.lines.length).toBe(4);
    expect(pr.vat).toMatchObject({ treatment: "EXCLUSIVE", status: "STATED" });
    expect(pr.lines.every((l) => l.unit_price_zar === null && l.source === "MISSING_INFORMATION")).toBe(true);
  });
});

describe("report and live script", () => {
  it("formats a report with pass and fail lines and totals", async () => {
    const fx = fixtureById("roads-rehabilitation")!;
    const res = await runAnalyst(fx, analystClient(fx));
    const rows: ReportRow[] = [
      { fixtureId: fx.id, title: fx.title, tags: fx.tags, score: scoreAnalysis(fx, res.output), error: null, costUsd: res.cost!.costUsd, inputTokens: res.cost!.inputTokens, outputTokens: res.cost!.outputTokens, ms: 12 },
      { fixtureId: "x", title: "x", tags: ["adversarial:prompt-injection"], score: null, error: "AiRefusalError: declined", costUsd: 0, inputTokens: 0, outputTokens: 0, ms: 1 },
    ];
    const text = formatReport(rows, { model: "model-mid", minRecall: 0.8 });
    expect(text).toMatch(/PASS\s+roads-rehabilitation\s+recall 100%/);
    expect(text).toMatch(/ERROR x/);
    expect(text).toMatch(/Passed 1 of 2/);
    expect(text).toMatch(/adversarial 0 of 1/);
  });

  it("is skipped, with no calls and no spend, unless ANTHROPIC_API_KEY is set", async () => {
    const lines: string[] = [];
    const r = await runLive({}, (l) => lines.push(l));
    expect(r).toMatchObject({ skipped: true, exitCode: 0, rows: [] });
    expect(lines.join("\n")).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect((await runLive({ ANTHROPIC_API_KEY: "   " }, () => undefined)).skipped).toBe(true);
  });

  it("refuses to start a paid run when the models or prices are not configured", async () => {
    const lines: string[] = [];
    const r = await runLive({ ANTHROPIC_API_KEY: "test-key-not-real" }, (l) => lines.push(l));
    expect(r).toMatchObject({ skipped: false, exitCode: 2, rows: [] });
    expect(lines.join("\n")).toMatch(/AI_MODEL_MID/);
  });

  it("builds a PDF that decodes to a real file with the text in it", () => {
    const b64 = makePdfBase64(["TENDER NO. 1", "Closing date: 3 November 2026"]);
    const raw = Buffer.from(b64, "base64").toString("latin1");
    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw).toContain("(Closing date: 3 November 2026) Tj");
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(raw)![1]);
    expect(raw.slice(xref, xref + 4)).toBe("xref");
  });
});
