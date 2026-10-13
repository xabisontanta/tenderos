/** Pages in the address bar, for lists that must not stop at the API's row limit. */

const MAX_PAGE = 1_000_000;

/** `?page=3` as a number; anything that is not a positive whole number is page 1. */
export function pageFromParam(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) return 1;
  const n = Number.parseInt(raw, 10);
  return n >= 1 ? Math.min(n, MAX_PAGE) : 1;
}

/** The inclusive `[from, to]` row range of a page, as `.range()` wants it. */
export function pageRange(page: number, size: number): [number, number] {
  return [(page - 1) * size, page * size - 1];
}

/** Number of pages for a total (at least one, so an empty list still has a page 1). */
export function pageCount(total: number | null, size: number): number {
  return Math.max(1, Math.ceil((total ?? 0) / size));
}
