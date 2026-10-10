import { describe, expect, it } from "vitest";
import { deriveAgentState, type AgentTaskSnapshot } from "@/lib/domain/agent-status";

const task = (o: Partial<AgentTaskSnapshot>): AgentTaskSnapshot => ({
  id: crypto.randomUUID(),
  tender_id: "t1",
  status: "QUEUED",
  priority: 5,
  created_at: new Date().toISOString(),
  run_active: true,
  ...o,
});

describe("deriveAgentState", () => {
  it("is IDLE with no tasks", () => {
    expect(deriveAgentState("IDLE", []).status).toBe("IDLE");
  });

  it("prefers RUNNING over other active work", () => {
    const running = task({ status: "RUNNING", created_at: "2026-01-01T00:00:00Z" });
    const d = deriveAgentState("IDLE", [task({ status: "QUEUED" }), running, task({ status: "NEEDS_APPROVAL" })]);
    expect(d.status).toBe("RUNNING");
    expect(d.currentTaskId).toBe(running.id);
  });

  it("shows NEEDS_APPROVAL ahead of queued work", () => {
    expect(deriveAgentState("IDLE", [task({ status: "QUEUED" }), task({ status: "NEEDS_APPROVAL" })]).status).toBe("NEEDS_APPROVAL");
  });

  it("keeps operator states sticky but still reports the current task", () => {
    const t = task({ status: "WAITING" });
    const d = deriveAgentState("PAUSED", [t]);
    expect(d.status).toBe("PAUSED");
    expect(d.currentTaskId).toBe(t.id);
    expect(deriveAgentState("DISABLED", []).status).toBe("DISABLED");
  });

  it("shows the last outcome only while its workflow is active", () => {
    expect(deriveAgentState("RUNNING", [task({ status: "COMPLETED" })]).status).toBe("COMPLETED");
    expect(deriveAgentState("RUNNING", [task({ status: "FAILED" })]).status).toBe("FAILED");
    expect(deriveAgentState("COMPLETED", [task({ status: "COMPLETED", run_active: false })]).status).toBe("IDLE");
  });
});
