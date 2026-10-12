import { describe, expect, it } from "vitest";
import { pricingOutputSchema } from "@/agents/pricing/schema";
import { pricingPrepareReal } from "@/agents/pricing/real";
import { SA_VAT_RATE } from "@/agents/pricing/logic";
import { ToolNotPermittedError } from "@/agents/runtime/tool-access";
import { FakeAiClient, type FakeReply } from "../support/fake-ai";
import { makeAi, makeCtx } from "../support/context";

const req = (id: string, text: string, quote: string, status = "EXTRACTED", category = "PRICING") => ({
  id,
  category,
  text,
  mandatory: true,
  status,
  source: { kind: "TENDER_DOCUMENT", document_id: "d1", page: 9, quote, quote_verified: status === "EXTRACTED" },
});

const analysis = (reqs: ReturnType<typeof req>[]) => ({ requirements: reqs, documents_analysed: 1, gaps: [], simulated: false, ai_generated: true });

const PIPE = req("doc-7", "Supply and lay 110 mm uPVC pipe, 200 m", "1.1 Supply and lay 110 mm uPVC pipe (m) 200");
const EXCAV = req("doc-8", "Excavation in all materials, 1 500 m3", "1.2 Excavate trench in all materials (m3) 1 500");
const VAT = req("doc-9", "Tendered prices must be inclusive of VAT", "All tendered prices must be quoted exclusive of VAT.");
const OTHER = req("doc-2", "Submit SBD 1", "The following documents must be submitted: SBD 1", "EXTRACTED", "DOCUMENT");

const line = (requirement_id: string, o: Record<string, unknown> = {}) => ({
  requirement_id,
  item_ref: "1.1",
  description: "Supply and lay 110 mm uPVC pipe",
  quantity: 200,
  unit: "m",
  supplier_quote_likely: true,
  ...o,
});
const reply = (lines: unknown[], vat = { treatment: "EXCLUSIVE", requirement_id: "doc-9" }, notes: string[] = []): FakeReply => ({
  json: { lines, vat, notes },
  usage: { inputTokens: 2500, outputTokens: 500 },
});

function setup(
  replies: ConstructorParameters<typeof FakeAiClient>[0],
  reqs: ReturnType<typeof req>[] | null = [PIPE, EXCAV, VAT, OTHER],
  allowedTools?: string[],
) {
  const client = new FakeAiClient(replies);
  const ctx = makeCtx({
    agent: "pricing",
    taskType: "pricing.prepare",
    stepKey: "pricing",
    previousOutputs: reqs ? { analysis: analysis(reqs) } : {},
    allowedTools,
    ai: makeAi(client, { agent: "pricing" }),
  });
  return { client, ctx };
}

describe("Pricing Analyst (AI)", () => {
  it("declares its needs", () => {
    expect(pricingPrepareReal).toMatchObject({ taskType: "pricing.prepare", agent: "pricing", tools: ["pricing.model"], ai: true });
  });

  it("structures the schedule from the analysed requirements without producing any figure of its own", async () => {
    const { ctx } = setup([
      reply([
        line("doc-7"),
        line("doc-8", { item_ref: "1.2", description: "Excavate trench in all materials", quantity: 1500, unit: "m3", supplier_quote_likely: false }),
      ]),
    ]);
    const res = await pricingPrepareReal.run(ctx);
    expect(pricingOutputSchema.safeParse(res.output).success).toBe(true);
    const out = res.output;
    expect(out.lines).toHaveLength(2);
    for (const l of out.lines) {
      expect(l.unit_price_zar).toBeNull();
      expect(l.source).toBe("MISSING_INFORMATION");
    }
    expect(out.lines[0]).toMatchObject({
      description: "Supply and lay 110 mm uPVC pipe",
      quantity: 200,
      unit: "m",
      requirement_id: "doc-7",
      supplier_quote_likely: true,
      page: 9,
    });
    expect(out.lines[0].quote).toBe(PIPE.source.quote);
    expect(out).toMatchObject({
      currency: "ZAR",
      vat_rate: SA_VAT_RATE,
      subtotal_zar: null,
      status: "REQUIRES_CONFIRMATION",
      requires_human_approval: true,
      simulated: false,
      ai_generated: true,
    });
    expect(out.notes.join(" ")).toMatch(/human approval/i);
    expect(res.cost).toMatchObject({ provider: "anthropic", isSimulated: false });
  });

  it("drops any price the model volunteers", async () => {
    const greedy = { ...line("doc-7"), unit_price_zar: 987654, rate: 987654, total: 197530800 };
    const { ctx } = setup([reply([greedy])]);
    const res = await pricingPrepareReal.run(ctx);
    expect(JSON.stringify(res.output)).not.toMatch(/987654|197530800/);
    expect(res.output.lines[0].unit_price_zar).toBeNull();
    expect(res.output.subtotal_zar).toBeNull();
  });

  it("gives the model no field in which to put a price", async () => {
    const { client, ctx } = setup([reply([line("doc-7")])]);
    await pricingPrepareReal.run(ctx);
    const schema = JSON.stringify(client.requests[0].outputSchema);
    expect(schema).not.toMatch(/price|rate|amount|total|cost/i);
  });

  it("keeps a quantity only when the printed line contains it", async () => {
    const { ctx } = setup([reply([line("doc-7", { quantity: 250 }), line("doc-8", { quantity: 1500, unit: "m3" })])]);
    const res = await pricingPrepareReal.run(ctx);
    expect(res.output.lines[0].quantity).toBeNull();
    expect(res.output.lines[0].warning).toMatch(/quantity.*not.*printed|not found/i);
    expect(res.output.lines[1].quantity).toBe(1500);
  });

  it("flags likely supplier-quotation needs", async () => {
    const { ctx } = setup([reply([line("doc-7"), line("doc-8", { quantity: 1500, supplier_quote_likely: false })])]);
    const res = await pricingPrepareReal.run(ctx);
    expect(res.output.notes.join(" ")).toMatch(/1 line.*supplier quotation/i);
  });

  it("reports VAT treatment only when a requirement about VAT backs it", async () => {
    const stated = await pricingPrepareReal.run(setup([reply([line("doc-7")])]).ctx);
    expect(stated.output.vat).toMatchObject({ rate: SA_VAT_RATE, treatment: "EXCLUSIVE", status: "STATED", requirement_id: "doc-9" });
    expect(stated.output.notes.join(" ")).toMatch(/exclusive of VAT/i);

    const invented = await pricingPrepareReal.run(setup([reply([line("doc-7")], { treatment: "INCLUSIVE", requirement_id: "doc-7" })]).ctx);
    expect(invented.output.vat).toMatchObject({ treatment: "NOT_STATED", status: "REQUIRES_CONFIRMATION" });
    expect(invented.output.notes.join(" ")).toMatch(/VAT treatment is not stated.*15%/i);

    const none = await pricingPrepareReal.run(setup([reply([line("doc-7")], { treatment: "NOT_STATED", requirement_id: "" })]).ctx);
    expect(none.output.vat?.status).toBe("REQUIRES_CONFIRMATION");
  });

  it("marks lines whose source requirement is itself unconfirmed", async () => {
    const shaky = req("doc-7", "Supply pipe, 200 m", "1.1 Supply and lay 110 mm uPVC pipe (m) 200", "REQUIRES_CONFIRMATION");
    const { ctx } = setup([reply([line("doc-7")])], [shaky, VAT]);
    const res = await pricingPrepareReal.run(ctx);
    expect(res.output.lines[0].warning).toMatch(/unconfirmed/i);
  });

  it("sends a line that points at a requirement that is not a price item back for repair", async () => {
    const { client, ctx } = setup([reply([line("doc-2")]), reply([line("doc-7")])]);
    const res = await pricingPrepareReal.run(ctx);
    expect(client.requests).toHaveLength(2);
    expect(res.output.lines).toHaveLength(1);
    expect((client.requests[1].messages[2].content[0] as { text: string }).text).toContain("doc-2");
  });

  it("does not let one requirement become two lines", async () => {
    const { client, ctx } = setup([reply([line("doc-7"), line("doc-7")]), reply([line("doc-7")])]);
    const res = await pricingPrepareReal.run(ctx);
    expect(client.requests).toHaveLength(2);
    expect(res.output.lines).toHaveLength(1);
  });

  it("makes no model call and invents no schedule when the analysis found no price lines", async () => {
    const { client, ctx } = setup([reply([line("doc-7")])], [OTHER]);
    const res = await pricingPrepareReal.run(ctx);
    expect(client.requests).toHaveLength(0);
    expect(res.output.lines).toEqual([]);
    expect(res.output.notes.join(" ")).toMatch(/no price schedule or bill of quantities/i);
    expect(res.output).toMatchObject({ status: "REQUIRES_CONFIRMATION", requires_human_approval: true, ai_generated: false });
    expect(res.cost).toMatchObject({ provider: "rules", costUsd: 0 });
  });

  it("copes with a missing analysis", async () => {
    const { client, ctx } = setup([], null);
    const res = await pricingPrepareReal.run(ctx);
    expect(client.requests).toHaveLength(0);
    expect(res.output.lines).toEqual([]);
  });

  it("is refused when the tool is not on the agent's list", async () => {
    const { client, ctx } = setup([reply([line("doc-7")])], [PIPE], []);
    await expect(pricingPrepareReal.run(ctx)).rejects.toBeInstanceOf(ToolNotPermittedError);
    expect(client.requests).toHaveLength(0);
  });

  it("shows requirement text to the model only as data", async () => {
    const { client, ctx } = setup([reply([line("doc-7")])]);
    await pricingPrepareReal.run(ctx);
    const block = client.requests[0].messages[0].content.find((b) => b.type === "text" && b.text.includes("[doc-7]"));
    expect(block && block.type === "text" && block.text.startsWith("<<<UNTRUSTED_DATA")).toBe(true);
    expect(client.requests[0].system).toMatch(/never.*price/i);
  });
});
