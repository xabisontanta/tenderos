export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** 0..1 fraction of jitter applied symmetrically. */
  jitter?: number;
  random?: () => number;
}

/** Exponential backoff with jitter: base * 2^attempt, capped. */
export function backoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = 2000, maxMs = 300_000, jitter = 0.2, random = Math.random } = opts;
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const delta = raw * jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(Math.min(maxMs, raw + delta)));
}

export function shouldRetry(retryCount: number, maxRetries: number, retryable: boolean): boolean {
  return retryable && retryCount < maxRetries;
}
