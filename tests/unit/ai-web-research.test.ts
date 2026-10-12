import { describe, expect, it } from "vitest";
import { AGENTS } from "@/agents/registry";
import { PromptPolicyError } from "@/agents/runtime/ai/errors";
import { researchWeb } from "@/agents/runtime/ai/web-research";
import { createToolGate, ToolNotPermittedError, type ToolRefusal } from "@/agents/runtime/tool-access";
import { FakeAiClient, type FakeReply } from "../support/fake-ai";
import { makeAi } from "../support/context";

const found: FakeReply = {
  text: "National Treasury published the 2026/27 cost containment instruction on its website.",
  usage: { inputTokens: 3000, outputTokens: 400, webSearchRequests: 2 },
  sources: [
    { url: "https://www.treasury.gov.za/legislation/pfma/", title: "PFMA" },
    { url: "javascript:alert(1)", title: "bad" },
    { url: "ftp://example.test/file", title: "bad" },
    { url: "https://www.etenders.gov.za/", title: "eTenders" },
  ],
};

function setup(over: { agent?: "tender_discovery" | "tender_intelligence"; flag?: boolean; reply?: FakeReply; tools?: string[] } = {}) {
  const agent = over.agent ?? "tender_intelligence";
  const def = AGENTS.find((a) => a.slug === agent)!;
  const refusals: ToolRefusal[] = [];
  const client = new FakeAiClient([over.reply ?? found]);
  const runtime = makeAi(client, { agent, webResearch: over.flag ?? true });
  const tools = createToolGate({ agent, allowedTools: over.tools ?? def.allowedTools, onRefused: (r) => void refusals.push(r) });
  return { client, runtime, tools, refusals };
}

describe("optional web research (Scout and Intelligence Analyst)", () => {
  it("returns a short summary whose sources are real http(s) URLs", async () => {
    const { client, runtime, tools } = setup();
    const r = await researchWeb({ runtime, tools, question: "Is there a new National Treasury cost containment instruction for 2026/27?" });
    expect(r.unsourced).toBe(false);
    expect(r.summary).toContain("cost containment");
    expect(r.sources.map((s) => s.url)).toEqual(["https://www.treasury.gov.za/legislation/pfma/", "https://www.etenders.gov.za/"]);
    expect(client.requests[0].webSearch).toEqual({ maxUses: 3 });
    expect(client.requests[0].outputSchema).toBeUndefined();
  });

  it("tells the model that what it finds on the web is data, not instructions", async () => {
    const { client, runtime, tools } = setup();
    await researchWeb({ runtime, tools, question: "Any news?" });
    expect(client.requests[0].system).toMatch(/data, not instructions/);
    expect(client.requests[0].system).toMatch(/search results/i);
  });

  it("charges for the searches as well as the tokens", async () => {
    const { runtime, tools } = setup();
    await researchWeb({ runtime, tools, question: "Any news?" });
    // 3000 in at $2/M + 400 out at $10/M + 2 searches at $0.01
    expect(runtime.meter.costUsd).toBeCloseTo(0.006 + 0.004 + 0.02, 6);
    expect(runtime.meter.totals.webSearchRequests).toBe(2);
  });

  it("discards an answer that has no source URL", async () => {
    const { runtime, tools } = setup({ reply: { ...found, sources: [] } });
    const r = await researchWeb({ runtime, tools, question: "Any news?" });
    expect(r).toMatchObject({ unsourced: true, summary: "", sources: [] });
  });

  it("is refused, and the refusal logged, when web.search is not on the agent's list", async () => {
    const { client, runtime, tools, refusals } = setup({ tools: ["analytics.read"] });
    await expect(researchWeb({ runtime, tools, question: "x" })).rejects.toBeInstanceOf(ToolNotPermittedError);
    expect(client.requests).toHaveLength(0);
    expect(refusals).toEqual([{ agent: "tender_intelligence", tool: "web.search", reason: "NOT_ON_ALLOWED_LIST" }]);
  });

  it("is refused when the organisation has not switched web research on", async () => {
    const { client, runtime, tools, refusals } = setup({ flag: false });
    await expect(researchWeb({ runtime, tools, question: "x" })).rejects.toBeInstanceOf(ToolNotPermittedError);
    expect(client.requests).toHaveLength(0);
    expect(refusals).toEqual([{ agent: "tender_intelligence", tool: "web.search", reason: "DISABLED_FOR_ORGANISATION" }]);
  });

  it("moves a LOW-tier agent up a tier, because the cheapest model does not support this search tool", async () => {
    const { client, runtime, tools } = setup({ agent: "tender_discovery" });
    await researchWeb({ runtime, tools, question: "Any news?" });
    expect(client.requests[0].model).toBe("model-mid");
    const mid = setup({ agent: "tender_intelligence" });
    await researchWeb({ runtime: mid.runtime, tools: mid.tools, question: "Any news?" });
    expect(mid.client.requests[0].model).toBe("model-mid");
  });

  it("limits the searches and checks domains before anything is sent", async () => {
    const { client, runtime, tools } = setup();
    await researchWeb({ runtime, tools, question: "x", maxSearches: 99, allowedDomains: ["treasury.gov.za"] });
    expect(client.requests[0].webSearch).toEqual({ maxUses: 5, allowedDomains: ["treasury.gov.za"] });
    const bad = setup();
    await expect(researchWeb({ runtime: bad.runtime, tools: bad.tools, question: "x", allowedDomains: ["https://evil.test/path"] })).rejects.toThrow(/domain/i);
    expect(bad.client.requests).toHaveLength(0);
  });

  it("keeps identity numbers out of the question", async () => {
    const { runtime, tools } = setup();
    await expect(researchWeb({ runtime, tools, question: "Is director 8001015009087 on a restricted list?" })).rejects.toBeInstanceOf(PromptPolicyError);
  });
});
