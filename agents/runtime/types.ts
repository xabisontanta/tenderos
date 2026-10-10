import type { z } from "zod";
import type { DataCategory, AgentSlug } from "@/agents/registry";
import type { Database } from "@/types/database";

type TenderRow = Database["public"]["Tables"]["tenders"]["Row"];

/** Company facts entered by the organisation (company_profiles row). */
export type CompanyProfile = Omit<Database["public"]["Tables"]["company_profiles"]["Row"], "updated_at" | "updated_by">;

/** The tender fields classified as PUBLIC_TENDER_DATA. */
export type TenderSnapshot = Pick<
  TenderRow,
  | "id"
  | "reference_number"
  | "title"
  | "issuing_organisation"
  | "description"
  | "province"
  | "sector"
  | "estimated_value_zar"
  | "published_at"
  | "closing_at"
  | "briefing_at"
  | "briefing_compulsory"
  | "briefing_location"
  | "questions_deadline_at"
  | "submission_method"
  | "submission_destination"
  | "source_url"
  | "is_simulation"
>;

export interface SimulationOptions {
  fail_step?: string;
  fail_times?: number;
}

export interface AgentContext {
  agentSlug: AgentSlug;
  task: {
    id: string;
    type: string;
    stepKey: string;
    input: Record<string, unknown>;
    retryCount: number;
  };
  workflow: {
    runId: string;
    correlationId: string;
    isSimulation: boolean;
    options: SimulationOptions;
  };
  /** Present only when the agent holds PUBLIC_TENDER_DATA. */
  tender: TenderSnapshot | null;
  /** Present only when the agent holds COMPANY_PROFILE and a profile exists. */
  company: CompanyProfile | null;
  /** Checkpointed outputs of earlier steps in this run, keyed by step key. */
  previousOutputs: Record<string, unknown>;
  /** Data categories this agent was granted for this task (already enforced). */
  granted: ReadonlySet<DataCategory>;
  now: Date;
  signal: AbortSignal;
  simulationStepMs: number;
  progress(percent: number, message: string): Promise<void>;
}

export interface DomainEvent {
  type: string;
  summary: string;
  severity?: Database["public"]["Enums"]["event_severity"];
  payload?: Record<string, unknown>;
}

export interface CostRecord {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  isSimulated: boolean;
}

export interface AgentResult<T> {
  output: T;
  /** One-line description of what the agent did, shown in the activity feed. */
  summary: string;
  events?: DomainEvent[];
  cost?: CostRecord;
}

export interface AgentExecutor<T = unknown> {
  taskType: string;
  agent: AgentSlug;
  /** Data categories the executor needs. The engine refuses to run it unless all are granted. */
  requires: DataCategory[];
  /** Categories the executor uses when the agent holds them (e.g. the company profile). */
  optional?: DataCategory[];
  outputSchema: z.ZodType<T>;
  run(ctx: AgentContext): Promise<AgentResult<T>>;
}

/** Thrown for failures that retrying cannot fix (e.g. the deadline has passed). */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export class PermissionDeniedError extends NonRetryableError {
  constructor(agent: string, missing: DataCategory[]) {
    super(`Agent ${agent} is not permitted to access: ${missing.join(", ")}`);
    this.name = "PermissionDeniedError";
  }
}

/** Marker for facts the system does not know and must not invent. */
export const UNKNOWN = {
  MISSING_INFORMATION: "MISSING_INFORMATION",
  REQUIRES_CONFIRMATION: "REQUIRES_CONFIRMATION",
} as const;
