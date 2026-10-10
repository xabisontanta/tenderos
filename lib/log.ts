/**
 * Minimal structured JSON logger. Keys that look like secrets or personal
 * data are redacted before anything is written.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT = /(pass(word)?|secret|token|key|authorization|cookie|id_number|bank|account_number)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, REDACT.test(k) ? "[REDACTED]" : redact(v, depth + 1)]),
  );
}

export function createLogger(base: Record<string, unknown> = {}, level: Level = (process.env.LOG_LEVEL as Level) || "info") {
  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...(redact({ ...base, ...fields }) as object) });
    (lvl === "error" || lvl === "warn" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
    info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
    warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
    error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
    child: (more: Record<string, unknown>) => createLogger({ ...base, ...more }, level),
  };
}
export type Logger = ReturnType<typeof createLogger>;
