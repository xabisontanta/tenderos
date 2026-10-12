import { describe, expect, it, vi } from "vitest";
import { AGENTS } from "@/agents/registry";
import { createToolGate, ToolNotPermittedError } from "@/agents/runtime/tool-access";
import { NonRetryableError } from "@/agents/runtime/types";
import { isEventType } from "@/lib/domain/events";

describe("tool gate (AGENTS.md section 5)", () => {
  const make = (allowed: string[], onRefused = vi.fn()) => ({ gate: createToolGate({ agent: "tender_analyst", allowedTools: allowed, onRefused }), onRefused });

  it("runs a tool on the agent's list and returns its result", async () => {
    const { gate, onRefused } = make(["tender.documents.read"]);
    await expect(gate.run("tender.documents.read", async () => 42)).resolves.toBe(42);
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("refuses a tool that is not on the list, never runs it and reports the refusal", async () => {
    const { gate, onRefused } = make(["tender.documents.read"]);
    const fn = vi.fn(async () => "side effect");
    await expect(gate.run("web.search", fn)).rejects.toBeInstanceOf(ToolNotPermittedError);
    expect(fn).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(onRefused).toHaveBeenCalledWith({ agent: "tender_analyst", tool: "web.search", reason: "NOT_ON_ALLOWED_LIST" });
  });

  it("fails the task at once instead of retrying", async () => {
    const { gate } = make([]);
    await expect(gate.run("anything", async () => 1)).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("matches tool ids exactly, with no prefixes or wildcards", async () => {
    const { gate } = make(["tender.documents.read", "tender.*"]);
    for (const tool of ["tender.documents.readall", "tender.documents", "Tender.Documents.Read", "tender.documents.write", "tender.x"]) {
      await expect(
        gate.run(tool, async () => 1),
        tool,
      ).rejects.toBeInstanceOf(ToolNotPermittedError);
    }
  });

  it("still refuses when reporting the refusal fails", async () => {
    const { gate } = make([], vi.fn().mockRejectedValue(new Error("db down")));
    await expect(gate.run("web.search", async () => 1)).rejects.toBeInstanceOf(ToolNotPermittedError);
  });

  it("lets a caller refuse a tool for a reason other than the list, with the same warning", async () => {
    const { gate, onRefused } = make(["web.search"]);
    await expect(gate.refuse("web.search", "DISABLED_FOR_ORGANISATION")).rejects.toBeInstanceOf(ToolNotPermittedError);
    expect(onRefused).toHaveBeenCalledWith({ agent: "tender_analyst", tool: "web.search", reason: "DISABLED_FOR_ORGANISATION" });
  });

  it("exposes the list it enforces", () => {
    expect(make(["a", "b"]).gate.allowed).toEqual(["a", "b"]);
  });
});

describe("registry tool lists", () => {
  it("grants web search only to the discovery and intelligence roles", () => {
    expect(
      AGENTS.filter((a) => a.allowedTools.includes("web.search"))
        .map((a) => a.slug)
        .sort(),
    ).toEqual(["tender_discovery", "tender_intelligence"]);
  });
  it("registers the refusal event type", () => {
    expect(isEventType("TOOL_REFUSED")).toBe(true);
  });
});
