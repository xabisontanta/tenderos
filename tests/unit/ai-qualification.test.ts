import { describe, expect, it } from "vitest";
import { qualificationOutputSchema } from "@/agents/qualification/schema";
import { opportunityQualificationReal } from "@/agents/qualification/real";
import { opportunityQualification } from "@/agents/qualification/simulated";
import { AiOutputError } from "@/agents/runtime/ai/errors";
import { ToolNotPermittedError } from "@/agents/runtime/tool-access";
import type { CompanyProfile } from "@/agents/runtime/types";
import { FakeAiClient, type FakeReply } from "../support/fake-ai";
import { makeAi, makeCtx, tender, inDays } from "../support/context";

const SENTINELS = ["Sentinel Person", "sentinel@example.test", "082 555 0199", "14 Sentinel Street", "SENTINELPIN", "4999999999", "2019/999999/07"];

const profile = (o: Partial<CompanyProfile> = {}): CompanyProfile => ({
  organisation_id: "00000000-0000-0000-0000-0000000000aa",
  legal_name: "Umzansi Civils (Pty) Ltd",
  trading_name: "Umzansi Civils",
  registration_number: "2019/999999/07",
  csd_number: "MAAA9999999",
  tax_pin: "SENTINELPIN",
  tax_pin_expires_at: "2027-01-01",
  vat_number: "4999999999",
  bbbee_level: 2,
  bbbee_expires_at: "2027-03-01",
  cidb_grade: "6CE",
  sectors: ["Construction", "Roads"],
  provinces: ["GAUTENG"],
  max_contract_value_zar: 25_000_000,
  authorised_signatory: "Sentinel Person",
  contact_person: "Sentinel Person",
  contact_email: "sentinel@example.test",
  contact_phone: "082 555 0199",
  physical_address: "14 Sentinel Street",
  postal_address: "14 Sentinel Street",
  website: null,
  ...o,
});

const analysis = {
  requirements: [
    { id: "doc-1", category: "MANDATORY_CONDITION", text: "CIDB grade 6CE or higher", mandatory: true, status: "EXTRACTED", source: { kind: "TENDER_DOCUMENT" } },
    { id: "closing", category: "DEADLINE", text: "Closes", mandatory: true, status: "EXTRACTED", source: { kind: "TENDER_RECORD" } },
  ],
  documents_analysed: 1,
  gaps: [],
  simulated: false,
};

const fit = (o: Record<string, unknown> = {}): FakeReply => ({
  json: {
    score: 82,
    confidence: "MEDIUM",
    reasons: [
      { factor: "CIDB_GRADE", assessment: "SUPPORTS", text: "Company holds CIDB 6CE, which meets the stated grade", fact_ids: ["fact:cidb_grade"], requirement_ids: ["doc-1"] },
      { factor: "GEOGRAPHY", assessment: "SUPPORTS", text: "Works in Gauteng", fact_ids: ["fact:provinces"], requirement_ids: [] },
      { factor: "EXPERIENCE", assessment: "UNKNOWN", text: "No past projects recorded", fact_ids: [], requirement_ids: [] },
    ],
    risks: [{ text: "Compulsory briefing attendance is not yet confirmed", requirement_ids: [] }],
    missing_information: ["Past experience on similar road projects"],
    ...o,
  },
  usage: { inputTokens: 3000, outputTokens: 600 },
});

function setup(replies: ConstructorParameters<typeof FakeAiClient>[0], o: { tender?: ReturnType<typeof tender>; company?: CompanyProfile | null; allowedTools?: string[] } = {}) {
  const client = new FakeAiClient(replies);
  const ctx = makeCtx({
    agent: "opportunity_qualification",
    taskType: "qualification.assess",
    stepKey: "qualification",
    tender: o.tender ?? tender(),
    company: o.company === undefined ? profile() : o.company,
    previousOutputs: { analysis },
    allowedTools: o.allowedTools,
    ai: makeAi(client, { agent: "opportunity_qualification" }),
  });
  return { client, ctx };
}

describe("Qualification Agent (AI fit)", () => {
  it("declares its needs", () => {
    expect(opportunityQualificationReal).toMatchObject({ taskType: "qualification.assess", agent: "opportunity_qualification", tools: ["company.capabilities.read"], ai: true });
  });

  it("keeps the rule gates and adds a drafted fit assessment with reasons and risks", async () => {
    const { client, ctx } = setup([fit()]);
    const res = await opportunityQualificationReal.run(ctx);
    expect(qualificationOutputSchema.safeParse(res.output).success).toBe(true);
    expect(res.output.decision).toBe("QUALIFIED");
    expect(res.output.ai_fit).toMatchObject({ score: 82, confidence: "MEDIUM", ai_generated: true });
    expect(res.output.ai_fit!.reasons).toHaveLength(3);
    expect(res.output.ai_fit!.risks[0].text).toMatch(/briefing/);
    expect(res.output.factors.map((f) => f.key)).toEqual(expect.arrayContaining(["deadline", "geography", "capability", "financial", "ai_fit"]));
    expect(res.output.factors.find((f) => f.key === "ai_fit")).toMatchObject({ result: "PASS", hard_disqualifier: false });
    expect(res.output.simulated).toBe(false);
    expect(client.requests[0].model).toBe("model-mid");
    expect(res.cost).toMatchObject({ provider: "anthropic", isSimulated: false });
    expect(res.cost!.costUsd).toBeGreaterThan(0);
  });

  it("produces the same rule result as the rules-only executor for everything the rules decide", async () => {
    const { ctx } = setup([fit()]);
    const sim = await opportunityQualification.run({ ...ctx, ai: null, workflow: { ...ctx.workflow, isSimulation: false } });
    const real = await opportunityQualificationReal.run(ctx);
    expect(real.output.decision).toBe(sim.output.decision);
    expect(real.output.hard_disqualifiers).toEqual(sim.output.hard_disqualifiers);
    expect(real.output.fit_score).toBe(sim.output.fit_score);
    for (const f of sim.output.factors) expect(real.output.factors).toContainEqual(f);
  });

  it("never calls the model, or overrides the gate, when a hard gate fails", async () => {
    const closingSoon = setup([fit({ score: 100 })], { tender: tender({ closing_at: inDays(1) }) });
    const a = await opportunityQualificationReal.run(closingSoon.ctx);
    expect(a.output.decision).toBe("REJECTED");
    expect(a.output.hard_disqualifiers.join()).toMatch(/Closing date/);
    expect(a.output.ai_fit).toBeNull();
    expect(a.output.ai_note).toMatch(/hard disqualifier/i);
    expect(closingSoon.client.requests).toHaveLength(0);
    expect(a.cost).toMatchObject({ provider: "rules", costUsd: 0 });

    const tooBig = setup([fit({ score: 100 })], { tender: tender({ estimated_value_zar: 90_000_000 }) });
    const b = await opportunityQualificationReal.run(tooBig.ctx);
    expect(b.output.decision).toBe("REJECTED");
    expect(tooBig.client.requests).toHaveLength(0);
    expect(b.events?.[0]).toMatchObject({ type: "TENDER_REJECTED" });
  });

  it("does not guess when there is nothing to compare: no company facts means no model call", async () => {
    const { client, ctx } = setup([fit()], { company: null });
    const res = await opportunityQualificationReal.run(ctx);
    expect(client.requests).toHaveLength(0);
    expect(res.output.ai_fit).toBeNull();
    expect(res.output.ai_note).toMatch(/company profile/i);
    expect(res.output.confirmation_required).toBe(true);
    expect(res.output.decision).toBe("QUALIFIED");
  });

  it("asks for confirmation instead of passing when the model has low confidence", async () => {
    const { ctx } = setup([fit({ confidence: "LOW" })]);
    const res = await opportunityQualificationReal.run(ctx);
    expect(res.output.factors.find((f) => f.key === "ai_fit")!.result).toBe("REQUIRES_CONFIRMATION");
    expect(res.output.confirmation_required).toBe(true);
  });

  it("maps a poor score to a warning factor that cannot reject the tender", async () => {
    const { ctx } = setup([fit({ score: 20 })]);
    const res = await opportunityQualificationReal.run(ctx);
    expect(res.output.factors.find((f) => f.key === "ai_fit")).toMatchObject({ result: "FAIL", hard_disqualifier: false });
    expect(res.output.decision).toBe("QUALIFIED");
    expect(res.output.hard_disqualifiers).toEqual([]);
  });

  it("sends a reason that cites a fact the company does not have back for repair", async () => {
    const bad = fit({ reasons: [{ factor: "CIDB_GRADE", assessment: "SUPPORTS", text: "Holds CIDB 9CE", fact_ids: ["fact:cidb_9ce"], requirement_ids: [] }] });
    const { client, ctx } = setup([bad, fit()]);
    const res = await opportunityQualificationReal.run(ctx);
    expect(client.requests).toHaveLength(2);
    expect(res.output.ai_fit!.reasons.every((r) => r.fact_ids.every((id) => id.startsWith("fact:")))).toBe(true);
    expect(res.cost!.inputTokens).toBe(6000);
  });

  it("will not accept support that cites no evidence, even after a repair", async () => {
    const unsupported = fit({ reasons: [{ factor: "EXPERIENCE", assessment: "SUPPORTS", text: "Extensive road experience", fact_ids: [], requirement_ids: [] }] });
    const { ctx } = setup([unsupported, unsupported]);
    await expect(opportunityQualificationReal.run(ctx)).rejects.toBeInstanceOf(AiOutputError);
  });

  it("sends no contact details, signatory, addresses, tax numbers or exposure limit to the model", async () => {
    const { client, ctx } = setup([fit()]);
    await opportunityQualificationReal.run(ctx);
    const everything = JSON.stringify(client.requests);
    for (const s of SENTINELS) expect(everything, s).not.toContain(s);
    expect(everything).not.toContain("25000000");
    expect(everything).toContain("6CE");
  });

  it("uses past experience and keywords from the profile when they exist", async () => {
    const rich = { ...profile(), keywords: ["tarring"], past_experience: "Built 12 km of municipal road in Polokwane." } as CompanyProfile;
    const { client, ctx } = setup([fit()], { company: rich });
    await opportunityQualificationReal.run(ctx);
    const everything = JSON.stringify(client.requests);
    expect(everything).toContain("Built 12 km of municipal road in Polokwane.");
    expect(everything).toContain("[fact:keywords]");
  });

  it("is refused when the tool is not on the agent's list", async () => {
    const { client, ctx } = setup([fit()], { allowedTools: [] });
    await expect(opportunityQualificationReal.run(ctx)).rejects.toBeInstanceOf(ToolNotPermittedError);
    expect(client.requests).toHaveLength(0);
  });

  it("tells the model that earlier requirement text is data", async () => {
    const { client, ctx } = setup([fit()]);
    await opportunityQualificationReal.run(ctx);
    const blocks = client.requests[0].messages[0].content;
    const reqBlock = blocks.find((b) => b.type === "text" && b.text.includes("[doc-1]"));
    expect(reqBlock && reqBlock.type === "text" && reqBlock.text.startsWith("<<<UNTRUSTED_DATA")).toBe(true);
  });
});
