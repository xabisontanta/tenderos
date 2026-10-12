import { describe, expect, it } from "vitest";
import { proposalOutputSchema } from "@/agents/proposal/schema";
import { proposalDraftReal } from "@/agents/proposal/real";
import { PROPOSAL_SECTIONS, ungroundedNumbers } from "@/agents/proposal/logic";
import { AiOutputError } from "@/agents/runtime/ai/errors";
import { ToolNotPermittedError } from "@/agents/runtime/tool-access";
import type { CompanyDocumentMeta, CompanyProfile } from "@/agents/runtime/types";
import { FakeAiClient, type FakeReply } from "../support/fake-ai";
import { makeAi, makeCtx } from "../support/context";

const profile = (o: Partial<CompanyProfile> = {}): CompanyProfile => ({
  organisation_id: "00000000-0000-0000-0000-0000000000aa",
  legal_name: "Umzansi Civils (Pty) Ltd",
  trading_name: null,
  registration_number: "2019/999999/07",
  csd_number: "MAAA9999999",
  tax_pin: "SENTINELPIN",
  tax_pin_expires_at: null,
  vat_number: "4999999999",
  bbbee_level: 2,
  bbbee_expires_at: null,
  cidb_grade: "6CE",
  sectors: ["Roads", "Civil engineering"],
  provinces: ["GAUTENG", "LIMPOPO"],
  max_contract_value_zar: 25_000_000,
  authorised_signatory: "Sentinel Person",
  contact_person: "Sentinel Person",
  contact_email: "sentinel@example.test",
  contact_phone: "082 555 0199",
  physical_address: "14 Sentinel Street",
  postal_address: null,
  website: null,
  ...o,
});

const analysis = {
  requirements: [
    {
      id: "doc-1",
      category: "MANDATORY_CONDITION",
      text: "CIDB grade 6CE or higher",
      mandatory: true,
      status: "EXTRACTED",
      source: { kind: "TENDER_DOCUMENT" },
    },
    {
      id: "doc-2",
      category: "SCOPE",
      text: "Rehabilitation of 4 km of access roads within 12 weeks",
      mandatory: true,
      status: "EXTRACTED",
      source: { kind: "TENDER_DOCUMENT" },
    },
  ],
  documents_analysed: 1,
  gaps: [],
  simulated: false,
  ai_generated: true,
};

const para = (text: string, fact_ids: string[] = [], requirement_ids: string[] = []) => ({ text, fact_ids, requirement_ids });
const section = (key: string, status: string, paragraphs: ReturnType<typeof para>[] = [], needs: string[] = []) => ({ key, status, paragraphs, needs });

const SUMMARY = section("executive_summary", "DRAFTED", [
  para("Umzansi Civils (Pty) Ltd is a CIDB grade 6CE contractor working in Gauteng and Limpopo.", ["fact:legal_name", "fact:cidb_grade", "fact:provinces"]),
  para("We understand the tender requires the rehabilitation of 4 km of access roads within 12 weeks.", [], ["doc-1", "doc-2"].slice(1)),
]);
const missingRest = PROPOSAL_SECTIONS.filter((s) => s.key !== "executive_summary").map((s) => section(s.key, "MISSING_INFORMATION", [], s.needs));

const reply = (sections: unknown[]): FakeReply => ({ json: { sections }, usage: { inputTokens: 5000, outputTokens: 900 } });

function setup(
  replies: ConstructorParameters<typeof FakeAiClient>[0],
  o: { company?: CompanyProfile | null; documents?: CompanyDocumentMeta[]; allowedTools?: string[] } = {},
) {
  const client = new FakeAiClient(replies);
  const ctx = makeCtx({
    agent: "proposal_writer",
    taskType: "proposal.draft",
    stepKey: "proposal",
    company: o.company === undefined ? profile() : o.company,
    documents: o.documents ?? [],
    previousOutputs: { analysis },
    allowedTools: o.allowedTools,
    ai: makeAi(client, { agent: "proposal_writer" }),
  });
  return { client, ctx };
}

describe("grounding of figures", () => {
  it("finds numbers that are not in the source material, ignoring spacing and thousands separators", () => {
    const source = "CIDB grade 6CE. Rehabilitation of 4 km within 12 weeks. Value R1 500 000.";
    expect(ungroundedNumbers("We will finish 4 km in 12 weeks", source)).toEqual([]);
    expect(ungroundedNumbers("A contract of R1,500,000", source)).toEqual([]);
    expect(ungroundedNumbers("We have 20 years of experience and ISO 9001", source).sort()).toEqual(["20", "9001"]);
  });
});

describe("Proposal Writer (AI)", () => {
  it("declares its needs", () => {
    expect(proposalDraftReal).toMatchObject({ taskType: "proposal.draft", agent: "proposal_writer", ai: true });
    expect(proposalDraftReal.tools).toEqual(["company.capabilities.read", "company.references.read"]);
  });

  it("drafts only what the facts support and leaves everything else MISSING_INFORMATION", async () => {
    const { client, ctx } = setup([reply([SUMMARY, ...missingRest])]);
    const res = await proposalDraftReal.run(ctx);
    expect(proposalOutputSchema.safeParse(res.output).success).toBe(true);
    const byKey = Object.fromEntries(res.output.sections.map((s) => [s.key, s]));
    expect(res.output.sections.map((s) => s.key)).toEqual(PROPOSAL_SECTIONS.map((s) => s.key));
    expect(byKey.executive_summary).toMatchObject({ status: "DRAFTED", title: "Executive summary" });
    expect(byKey.executive_summary.content).toContain("CIDB grade 6CE");
    expect(byKey.executive_summary.paragraphs).toHaveLength(2);
    expect(byKey.executive_summary.paragraphs![0].fact_ids).toContain("fact:cidb_grade");
    for (const k of ["methodology", "staffing", "experience"]) expect(byKey[k]).toMatchObject({ status: "MISSING_INFORMATION", content: null });
    expect(res.output.open_items).toBe(PROPOSAL_SECTIONS.length - 1);
    expect(res.output).toMatchObject({ simulated: false, ai_generated: true });
    expect(client.requests[0].model).toBe("model-mid");
    expect(res.cost).toMatchObject({ provider: "anthropic", isSimulated: false });
    expect(res.events?.[0]).toMatchObject({ type: "PROPOSAL_GENERATED" });
    expect(res.events?.[0].summary).toMatch(/AI draft/i);
  });

  it("flags every paragraph with the facts and requirements it addresses", async () => {
    const { ctx } = setup([reply([SUMMARY, ...missingRest])]);
    const res = await proposalDraftReal.run(ctx);
    const paragraphs = res.output.sections.flatMap((s) => s.paragraphs ?? []);
    expect(paragraphs.length).toBeGreaterThan(0);
    for (const p of paragraphs) expect(p.fact_ids.length + p.requirement_ids.length).toBeGreaterThan(0);
  });

  it("sends a paragraph that cites a fact that does not exist back for repair", async () => {
    const invented = section("experience", "DRAFTED", [para("We built the N1 upgrade in 2019.", ["doc:made-up"])]);
    const { client, ctx } = setup([reply([SUMMARY, invented]), reply([SUMMARY, ...missingRest])]);
    const res = await proposalDraftReal.run(ctx);
    expect(client.requests).toHaveLength(2);
    expect(res.output.sections.find((s) => s.key === "experience")!.status).toBe("MISSING_INFORMATION");
    expect((client.requests[1].messages[2].content[0] as { text: string }).text).toContain("doc:made-up");
  });

  it("will not accept an uncited paragraph even after a repair", async () => {
    const uncited = section("executive_summary", "DRAFTED", [para("We are the best contractor in the province.")]);
    const { ctx } = setup([reply([uncited]), reply([uncited])]);
    await expect(proposalDraftReal.run(ctx)).rejects.toBeInstanceOf(AiOutputError);
  });

  it("drops a cited paragraph that states figures found nowhere in the facts or requirements", async () => {
    const boastful = section("executive_summary", "DRAFTED", [
      para("Umzansi Civils (Pty) Ltd is a CIDB grade 6CE contractor.", ["fact:legal_name", "fact:cidb_grade"]),
      para("We have 25 years of experience and completed 140 road projects.", ["fact:sectors"]),
    ]);
    const { ctx } = setup([reply([boastful, ...missingRest])]);
    const res = await proposalDraftReal.run(ctx);
    const s = res.output.sections.find((x) => x.key === "executive_summary")!;
    expect(s.content).not.toMatch(/25 years|140/);
    expect(s.content).toContain("6CE");
    expect(s.status).toBe("REQUIRES_CONFIRMATION");
    expect(s.warnings?.join(" ")).toMatch(/25.*140|figures/);
    expect(s.paragraphs).toHaveLength(1);
  });

  it("makes a section with nothing left MISSING_INFORMATION", async () => {
    const onlyBoast = section("experience", "DRAFTED", [para("We completed 140 road projects.", ["fact:sectors"])]);
    const { ctx } = setup([reply([onlyBoast])]);
    const res = await proposalDraftReal.run(ctx);
    expect(res.output.sections.find((s) => s.key === "experience")).toMatchObject({ status: "MISSING_INFORMATION", content: null });
  });

  it("does not call a section drafted when the model still lists what it needs", async () => {
    const partial = section(
      "executive_summary",
      "DRAFTED",
      [para("Umzansi Civils (Pty) Ltd works in Gauteng.", ["fact:legal_name", "fact:provinces"])],
      ["Company overview"],
    );
    const { ctx } = setup([reply([partial, ...missingRest])]);
    const res = await proposalDraftReal.run(ctx);
    expect(res.output.sections[0]).toMatchObject({ status: "REQUIRES_CONFIRMATION", needs: ["Company overview"] });
  });

  it("fills sections the model left out and ignores sections it invented", async () => {
    const { ctx } = setup([reply([SUMMARY, section("secret_section", "DRAFTED", [para("x", ["fact:legal_name"])])])]);
    const res = await proposalDraftReal.run(ctx);
    expect(res.output.sections.map((s) => s.key)).toEqual(PROPOSAL_SECTIONS.map((s) => s.key));
    expect(res.output.sections.find((s) => s.key === "methodology")!.needs.length).toBeGreaterThan(0);
  });

  it("does not call the model when there is no company information to draft from", async () => {
    const { client, ctx } = setup([reply([SUMMARY])], { company: null });
    const res = await proposalDraftReal.run(ctx);
    expect(client.requests).toHaveLength(0);
    expect(res.output.sections.every((s) => s.status === "MISSING_INFORMATION" && s.content === null)).toBe(true);
    expect(res.output.open_items).toBe(PROPOSAL_SECTIONS.length);
    expect(res.output.ai_generated).toBe(false);
    expect(res.cost).toMatchObject({ provider: "rules", costUsd: 0 });
  });

  it("uses verified, in-date reference documents but never unverified or restricted ones, and never file names", async () => {
    const docs: CompanyDocumentMeta[] = [
      {
        id: "ref1",
        doc_type: "project_references",
        title: "Reference letter, Polokwane roads",
        file_name: "SENTINEL-FILE.pdf",
        expires_at: null,
        verified: true,
      },
      { id: "ref2", doc_type: "project_references", title: "Unverified letter", file_name: "x.pdf", expires_at: null, verified: false },
      { id: "id1", doc_type: "director_ids", title: "Director ID", file_name: "id.pdf", expires_at: null, verified: true },
    ];
    const { client, ctx } = setup([reply([SUMMARY, ...missingRest])], { documents: docs });
    await proposalDraftReal.run(ctx);
    const everything = JSON.stringify(client.requests);
    expect(everything).toContain("[doc:ref1]");
    expect(everything).not.toContain("doc:ref2");
    expect(everything).not.toContain("doc:id1");
    for (const s of [
      "SENTINEL-FILE",
      "Sentinel Person",
      "sentinel@example.test",
      "082 555 0199",
      "14 Sentinel Street",
      "SENTINELPIN",
      "4999999999",
      "2019/999999/07",
    ])
      expect(everything, s).not.toContain(s);
  });

  it("is refused when either company tool is not on the agent's list", async () => {
    const { client, ctx } = setup([reply([SUMMARY])], { allowedTools: ["company.capabilities.read"] });
    await expect(proposalDraftReal.run(ctx)).rejects.toBeInstanceOf(ToolNotPermittedError);
    expect(client.requests).toHaveLength(0);
  });

  it("tells the model the draft is for review and shows tender text only as data", async () => {
    const { client, ctx } = setup([reply([SUMMARY, ...missingRest])]);
    await proposalDraftReal.run(ctx);
    expect(client.requests[0].system).toMatch(/draft/i);
    expect(client.requests[0].system).toMatch(/data, not instructions/);
    const reqBlock = client.requests[0].messages[0].content.find((b) => b.type === "text" && b.text.includes("[doc-2]"));
    expect(reqBlock && reqBlock.type === "text" && reqBlock.text.startsWith("<<<UNTRUSTED_DATA")).toBe(true);
  });
});
