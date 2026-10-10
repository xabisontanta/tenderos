import { createHash } from "node:crypto";

/** Deterministic hash of the bid package manifest (step outputs), key-order independent. */
export function packageHash(manifest: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(manifest)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}
