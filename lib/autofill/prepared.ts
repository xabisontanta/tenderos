import { formatDateTime } from "@/lib/format";

/**
 * "Prepared by TenderOS at <time>: N fields, M documents": what the tender
 * page says after the browser helper reported (agent_events BID_FORM_PREPARED,
 * written by autofill_record_prepared). Counts and a host only.
 */
export interface PreparedSummary {
  at: string;
  host: string;
  fields: number;
  documents: number;
  left: number;
}

const count = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 10_000;

export function parsePreparedEvent(row: { created_at: string; event_type: string; payload: unknown } | null | undefined): PreparedSummary | null {
  if (!row || row.event_type !== "BID_FORM_PREPARED") return null;
  const p = row.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  if (typeof o.host !== "string" || o.host.length === 0 || o.host.length > 253 || !count(o.fields) || !count(o.documents) || !count(o.left)) return null;
  return { at: row.created_at, host: o.host, fields: o.fields as number, documents: o.documents as number, left: o.left as number };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function describePrepared(p: PreparedSummary): string {
  return `Prepared by TenderOS on ${formatDateTime(p.at)}: ${plural(p.fields, "field", "fields")}, ${plural(p.documents, "document", "documents")} on ${p.host}. ${
    p.left > 0 ? `${plural(p.left, "item", "items")} left for you. ` : ""
  }Check everything, then submit it yourself.`;
}
