import { NonRetryableError } from "../types";

/**
 * AI configuration is missing or invalid. Real execution refuses to run
 * instead of falling back to another model, a default price or the rules-only
 * path (AGENTS.md section 11).
 */
export class AiNotConfiguredError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = "AiNotConfiguredError";
  }
}

/** A prompt would carry data the agent may not send to a model. Never retried. */
export class PromptPolicyError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = "PromptPolicyError";
  }
}

/** The model's output could not be turned into valid structured data, even after one repair attempt. */
export class AiOutputError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = "AiOutputError";
  }
}

/** The provider rejected the request (4xx other than rate limiting). Retrying the same request cannot help. */
export class AiRequestError extends NonRetryableError {
  constructor(
    message: string,
    readonly status: number | null,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "AiRequestError";
  }
}

/** The model declined to answer. Needs a person; retrying the same request will not change the outcome. */
export class AiRefusalError extends NonRetryableError {
  constructor(readonly category: string | null) {
    super(`The model declined this request${category ? ` (${category})` : ""}; a person needs to review the tender`);
    this.name = "AiRefusalError";
  }
}

/** The provider is temporarily unavailable. Retryable at task level after in-call retries are used up. */
export class AiTransientError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "AiTransientError";
  }
}

/** The prompt is larger than the configured input limit. Split the material instead of sending it. */
export class AiInputTooLargeError extends NonRetryableError {
  constructor(
    message: string,
    readonly tokens: number,
  ) {
    super(message);
    this.name = "AiInputTooLargeError";
  }
}

/** A task or call would spend more than the configured per-task ceiling. */
export class AiBudgetError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = "AiBudgetError";
  }
}
