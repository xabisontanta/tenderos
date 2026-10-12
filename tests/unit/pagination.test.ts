import { describe, expect, it } from "vitest";
import { pageCount, pageFromParam, pageRange } from "@/lib/pagination";
import { ALL_TENDER_STATUSES, pipelineStage, stageCounts } from "@/lib/domain/tender-state";

describe("pagination", () => {
  it("reads the page from the address, defaulting to 1 for anything that is not a positive whole number", () => {
    expect(pageFromParam("3")).toBe(3);
    for (const bad of [undefined, "", "0", "-2", "abc", "2.5", "1e3", " "]) expect(pageFromParam(bad as string | undefined), String(bad)).toBe(1);
    expect(pageFromParam("999999999999")).toBe(1_000_000); // absurd pages are capped, not trusted
  });

  it("turns a page into the inclusive row range the API wants", () => {
    expect(pageRange(1, 50)).toEqual([0, 49]);
    expect(pageRange(3, 50)).toEqual([100, 149]);
  });

  it("counts pages, with at least one", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
    expect(pageCount(null, 50)).toBe(1);
  });
});

describe("stageCounts", () => {
  it("groups counts by status into the pipeline stages, from the database's own totals", () => {
    const stages = stageCounts({
      DISCOVERED: 1200,
      INGESTING: 1,
      QUALIFYING: 2,
      PREPARING_BID: 4,
      READY_FOR_APPROVAL: 1,
      SUBMITTED: 5,
      AWARDED: 2,
      UNSUCCESSFUL: 1,
      CANCELLED: 3,
    });
    expect(stages).toEqual({ new: 1200, qualifying: 3, preparing: 4, approval: 1, submitted: 5, won: 2, lost: 1, closed: 3 });
  });

  it("has every stage even when there is nothing in it, and ignores statuses it does not know", () => {
    expect(stageCounts({})).toEqual({ new: 0, qualifying: 0, preparing: 0, approval: 0, submitted: 0, won: 0, lost: 0, closed: 0 });
    expect(stageCounts({ FROM_THE_FUTURE: 9 })).toEqual(stageCounts({}));
  });

  it("agrees with pipelineStage for every status, so no tender is counted twice or lost", () => {
    const everyStatusOnce = Object.fromEntries(ALL_TENDER_STATUSES.map((s) => [s, 1]));
    const stages = stageCounts(everyStatusOnce);
    expect(Object.values(stages).reduce((a, b) => a + b, 0)).toBe(ALL_TENDER_STATUSES.length);
    for (const s of ALL_TENDER_STATUSES) expect(stageCounts({ [s]: 1 })[pipelineStage(s)]).toBe(1);
  });
});
