import { NonRetryableError } from "./types";

export type ToolRefusalReason = "NOT_ON_ALLOWED_LIST" | "DISABLED_FOR_ORGANISATION";

export interface ToolRefusal {
  agent: string;
  tool: string;
  reason: ToolRefusalReason;
}

export class ToolNotPermittedError extends NonRetryableError {
  constructor(
    readonly agent: string,
    readonly tool: string,
    readonly reason: ToolRefusalReason,
  ) {
    super(
      reason === "NOT_ON_ALLOWED_LIST"
        ? `Agent ${agent} is not permitted to use tool "${tool}"; it is not on the agent's allowed tools`
        : `Tool "${tool}" is switched off for this organisation`,
    );
    this.name = "ToolNotPermittedError";
  }
}

export interface ToolGate {
  /** The agent's allow-list, exactly as stored on its row. */
  readonly allowed: readonly string[];
  /** Runs `fn` if `tool` is on the allow-list. Otherwise reports the refusal and throws without running it. */
  run<T>(tool: string, fn: () => Promise<T>): Promise<T>;
  /** Refuses a tool for a reason other than the list (for example an organisation switch), with the same report. */
  refuse(tool: string, reason: ToolRefusalReason): Promise<never>;
}

/**
 * The runtime side of AGENTS.md section 5. Ids match exactly: there are no
 * wildcards and no prefixes. A refusal is reported through `onRefused` (the
 * engine writes an agent_events WARNING) and then fails the task without a
 * retry. A failure to report never turns a refusal into permission.
 */
export function createToolGate(opts: {
  agent: string;
  allowedTools: readonly string[];
  onRefused: (refusal: ToolRefusal) => Promise<void> | void;
}): ToolGate {
  const allowed = [...opts.allowedTools];
  const refuse = async (tool: string, reason: ToolRefusalReason): Promise<never> => {
    try {
      await opts.onRefused({ agent: opts.agent, tool, reason });
    } catch {
      // The refusal stands even if it could not be recorded.
    }
    throw new ToolNotPermittedError(opts.agent, tool, reason);
  };
  return {
    allowed,
    refuse,
    async run(tool, fn) {
      if (!allowed.includes(tool)) return refuse(tool, "NOT_ON_ALLOWED_LIST");
      return fn();
    },
  };
}
