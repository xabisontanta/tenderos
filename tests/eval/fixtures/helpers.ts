import type { ExtractionItem } from "@/agents/analysis/schema";
import type { ExpectedRequirement } from "../types";

/** Joins lines into one page of text, one line per paragraph. */
export const page = (...lines: string[]): string => lines.join("\n");

type Base = Pick<ExpectedRequirement, "category" | "document_id">;

/**
 * Builds an expected requirement. `quote` must be a line that appears in the
 * fixture's document; building both from the same constant keeps them equal.
 */
export function expectReq(
  doc: string,
  key: string,
  category: ExpectedRequirement["category"],
  mandatory: boolean,
  quote: string,
  pageNo: number | null,
  textIncludes: string[],
  extra: Partial<Pick<ExpectedRequirement, "date" | "status" | "section">> = {},
): ExpectedRequirement {
  const base: Base = { category, document_id: doc };
  return {
    key,
    ...base,
    mandatory,
    quote,
    page: pageNo,
    section: extra.section ?? "",
    textIncludes,
    status: extra.status ?? "EXTRACTED",
    ...(extra.date ? { date: extra.date } : {}),
  };
}

/** The item a faithful model would return for an expected requirement. */
export function itemFor(e: ExpectedRequirement): ExtractionItem {
  return {
    category: e.category,
    text: e.textIncludes[0] ?? e.key,
    mandatory: e.mandatory,
    document_id: e.document_id,
    page: e.page,
    section: e.section,
    quote: e.quote,
    date_iso: e.date?.iso ?? null,
    date_kind: e.date?.kind ?? "NONE",
  };
}
