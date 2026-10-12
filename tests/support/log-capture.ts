import { vi } from "vitest";
import { createLogger } from "@/lib/log";

/** A real logger (with its redaction) whose output is collected instead of written to the console. */
export function captureLogs() {
  const lines: string[] = [];
  const sink = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  const out = vi.spyOn(process.stdout, "write").mockImplementation(sink as never);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(sink as never);
  return {
    logger: createLogger({ service: "test" }, "debug"),
    text: () => lines.join(""),
    records: () =>
      lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    restore: () => {
      out.mockRestore();
      err.mockRestore();
    },
  };
}
