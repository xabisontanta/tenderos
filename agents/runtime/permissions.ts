import type { DataCategory } from "@/agents/registry";
import { PermissionDeniedError, type AgentExecutor } from "./types";

/**
 * Least-privilege gate: an executor runs only if the agent holds every data
 * category it declares. Returns the granted set to place on the context,
 * including any optional categories the agent also holds.
 */
export function authoriseExecutor(
  executor: Pick<AgentExecutor, "agent" | "requires" | "optional">,
  agentGrants: readonly DataCategory[],
): ReadonlySet<DataCategory> {
  const granted = new Set(agentGrants);
  const missing = executor.requires.filter((c) => !granted.has(c));
  if (missing.length > 0) throw new PermissionDeniedError(executor.agent, missing);
  // Optional categories are released only when the agent holds them.
  return new Set([...executor.requires, ...(executor.optional ?? []).filter((c) => granted.has(c))]);
}
