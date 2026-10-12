import { describe, expect, it } from "vitest";
import { AGENTS } from "@/agents/registry";
import { REAL_EXECUTORS, SIMULATED_EXECUTORS, getExecutor } from "@/agents";
import { PROMPT_PROHIBITED_CATEGORIES } from "@/agents/runtime/permissions";

describe("executor selection", () => {
  const taskTypes = Object.keys(SIMULATED_EXECUTORS);

  it("defaults to the simulated / rules-only executors", () => {
    for (const t of taskTypes) expect(getExecutor(t)).toBe(SIMULATED_EXECUTORS[t]);
  });

  it("never uses an AI executor in a simulation run, even when AI is on", () => {
    for (const t of taskTypes) expect(getExecutor(t, { simulation: true, aiEnabled: true })).toBe(SIMULATED_EXECUTORS[t]);
  });

  it("never uses an AI executor on a real tender while AI is off", () => {
    for (const t of taskTypes) expect(getExecutor(t, { simulation: false, aiEnabled: false })).toBe(SIMULATED_EXECUTORS[t]);
  });

  it("uses the AI executor on a real tender when AI is on, and keeps rules for steps that have none", () => {
    expect(getExecutor("analysis.extract", { simulation: false, aiEnabled: true })).toBe(REAL_EXECUTORS["analysis.extract"]);
    for (const t of ["director.intake", "compliance.check", "submission.execute"]) {
      expect(REAL_EXECUTORS[t], t).toBeUndefined();
      expect(getExecutor(t, { simulation: false, aiEnabled: true })).toBe(SIMULATED_EXECUTORS[t]);
    }
  });

  it("returns nothing for an unknown task type", () => {
    expect(getExecutor("nope", { simulation: false, aiEnabled: true })).toBeUndefined();
  });
});

describe("AI executors", () => {
  for (const [type, e] of Object.entries(REAL_EXECUTORS)) {
    const agent = AGENTS.find((a) => a.slug === e.agent)!;
    describe(type, () => {
      it("replaces the simulated executor of the same agent and task type", () => {
        expect(SIMULATED_EXECUTORS[type]?.agent).toBe(e.agent);
        expect(e.taskType).toBe(type);
        expect(e.ai).toBe(true);
      });
      it("only requires data categories its agent holds, and never a prompt-prohibited one", () => {
        for (const c of [...e.requires, ...(e.optional ?? [])]) {
          expect(agent.dataCategories, c).toContain(c);
          expect(PROMPT_PROHIBITED_CATEGORIES as readonly string[], c).not.toContain(c);
        }
      });
      it("only calls tools that are on its agent's allowed list", () => {
        for (const tool of e.tools ?? []) expect(agent.allowedTools, tool).toContain(tool);
        expect((e.tools ?? []).length).toBeGreaterThan(0);
      });
    });
  }
});
