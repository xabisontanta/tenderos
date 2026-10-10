import { describe, expect, it } from "vitest";
import { AGENTS, validateRegistry } from "@/agents/registry";
import { SIMULATED_EXECUTORS } from "@/agents";
import { authoriseExecutor } from "@/agents/runtime/permissions";
import { PermissionDeniedError } from "@/agents/runtime/types";
import { selectModel, selectTier, estimateCostUsd } from "@/agents/runtime/model-routing";
import { backoffMs, shouldRetry } from "@/workflows/retry";
import { simulatedBidWorkflow } from "@/workflows/definitions/simulated-bid";
import { redact } from "@/lib/log";
import { buildCsp } from "@/lib/security/csp";

describe("agent registry", () => {
  it("is internally consistent", () => {
    expect(() => validateRegistry()).not.toThrow();
  });

  it("follows data-minimisation rules", () => {
    const cats = (slug: string) => AGENTS.find((a) => a.slug === slug)!.dataCategories;
    expect(cats("tender_discovery")).toEqual(["PUBLIC_TENDER_DATA"]);
    expect(cats("proposal_writer")).not.toContain("DIRECTOR_PERSONAL");
    expect(cats("pricing")).not.toContain("PROOF_OF_ADDRESS");
    for (const a of AGENTS.filter((x) => x.slug !== "document_manager")) {
      expect(a.dataCategories, a.slug).not.toContain("BANKING");
      expect(a.dataCategories, a.slug).not.toContain("DIRECTOR_PERSONAL");
    }
  });

  it("every executor's agent holds the categories it requires", () => {
    for (const e of Object.values(SIMULATED_EXECUTORS)) {
      const def = AGENTS.find((a) => a.slug === e.agent)!;
      expect(() => authoriseExecutor(e, def.dataCategories), e.taskType).not.toThrow();
    }
  });
});

describe("permission gate", () => {
  it("refuses executors needing categories the agent lacks", () => {
    expect(() => authoriseExecutor({ agent: "pricing", requires: ["PUBLIC_TENDER_DATA", "BANKING"] }, ["PUBLIC_TENDER_DATA"])).toThrow(PermissionDeniedError);
  });
  it("grants only what the executor declared", () => {
    const g = authoriseExecutor({ agent: "x" as never, requires: ["PUBLIC_TENDER_DATA"] }, ["PUBLIC_TENDER_DATA", "PRICING"]);
    expect([...g]).toEqual(["PUBLIC_TENDER_DATA"]);
  });
});

describe("model routing", () => {
  const models = { LOW: "low-model", MID: "mid-model", HIGH: "high-model" };
  it("uses the agent tier by default and escalates for high-value work", () => {
    expect(selectTier({ agentTier: "LOW" })).toBe("LOW");
    expect(selectTier({ agentTier: "MID", highValue: true })).toBe("HIGH");
    expect(selectTier({ agentTier: "HIGH", complex: true })).toBe("HIGH");
  });
  it("honours overrides and reports unconfigured models as null", () => {
    expect(selectModel({ agentTier: "LOW", override: "custom" }, models).model).toBe("custom");
    expect(selectModel({ agentTier: "MID" }, { LOW: undefined, MID: undefined, HIGH: undefined }).model).toBeNull();
  });
  it("estimates cost from per-million prices", () => {
    expect(estimateCostUsd(1_000_000, 500_000, { inputPerMillion: 1, outputPerMillion: 4 })).toBe(3);
  });
});

describe("retry policy", () => {
  it("backs off exponentially and caps", () => {
    const fixed = { jitter: 0, baseMs: 1000, maxMs: 10_000 };
    expect([0, 1, 2, 3, 4, 10].map((a) => backoffMs(a, fixed))).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
  });
  it("stays within jitter bounds", () => {
    for (let i = 0; i < 50; i++) {
      const v = backoffMs(2, { baseMs: 1000, jitter: 0.2 });
      expect(v).toBeGreaterThanOrEqual(3200);
      expect(v).toBeLessThanOrEqual(4800);
    }
  });
  it("never retries non-retryable errors or past the limit", () => {
    expect(shouldRetry(0, 3, false)).toBe(false);
    expect(shouldRetry(3, 3, true)).toBe(false);
    expect(shouldRetry(2, 3, true)).toBe(true);
  });
});

describe("simulated bid workflow definition", () => {
  const sim = { isSimulation: true };
  it("routes qualification rejection to completion", () => {
    expect(simulatedBidWorkflow.resolve("qualification", { decision: "REJECTED" }, sim)).toMatchObject({ tender: ["REJECTED"], next: { type: "complete" } });
  });
  it("blocks on missing compliance in a live run but continues in simulation", () => {
    const out = { outcome: "INCOMPLETE", missing: ["CSD"], continued_in_simulation: true };
    expect(simulatedBidWorkflow.resolve("compliance", out, { isSimulation: false })).toMatchObject({
      tender: ["MISSING_INFORMATION"],
      next: { type: "block" },
    });
    expect(simulatedBidWorkflow.resolve("compliance", out, sim).next).toMatchObject({ type: "step", key: "proposal" });
  });
  it("routes QA to the approval gate, never straight to submission", () => {
    expect(simulatedBidWorkflow.resolve("qa", { verdict: "CONDITIONAL", open_issues: ["x"] }, sim).next).toMatchObject({ type: "step", key: "approval" });
    expect(simulatedBidWorkflow.resolve("qa", { verdict: "FAIL", open_issues: ["x"] }, sim)).toMatchObject({ tender: ["QA_FAILED"], next: { type: "block" } });
  });
  it("blocks physical submissions for a person to complete", () => {
    expect(simulatedBidWorkflow.resolve("submission", { status: "ACTION_REQUIRED", receipt_note: "deliver" }, sim).next.type).toBe("block");
  });
});

describe("log redaction", () => {
  it("redacts secret-looking keys at any depth", () => {
    expect(redact({ a: 1, apiKey: "x", nested: { password: "p", bank_account_number: "1" } })).toEqual({
      a: 1,
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]", bank_account_number: "[REDACTED]" },
    });
  });
});

describe("content security policy", () => {
  it("restricts scripts to the nonce and connections to Supabase", () => {
    const csp = buildCsp("abc", "https://proj.supabase.co", false);
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("connect-src 'self' https://proj.supabase.co wss://proj.supabase.co");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
