import { describe, expect, it } from "vitest";
import {
  formatCents,
  lineAmountCents,
  MAX_AMOUNT_CENTS,
  parseQuantity,
  parseRandsToCents,
  priceSchedule,
  SA_VAT_PERCENT,
  vatCents,
  type ScheduleLine,
} from "@/lib/domain/bid-money";

describe("parseRandsToCents: what a person types becomes whole cents", () => {
  it.each([
    ["0", 0],
    ["0.5", 50],
    ["12", 1200],
    ["12.3", 1230],
    ["12.34", 1234],
    ["12,34", 1234],
    ["  1234.56  ", 123456],
    ["1 234.56", 123456],
    ["1 234,56", 123456],
    ["R 1500", 150000],
    ["r1500.00", 150000],
    ["0.01", 1],
    ["10000000000", 1_000_000_000_000],
  ])("%s is %s cents", (input, cents) => {
    expect(parseRandsToCents(input)).toEqual({ ok: true, cents });
  });

  it.each([
    ["", "enter an amount"],
    ["   ", "enter an amount"],
    ["abc", "digits"],
    ["1.234", "cents"],
    ["1,234.56", "digits"],
    ["1.2.3", "digits"],
    ["-5", "negative"],
    ["R-5", "negative"],
    ["1e3", "digits"],
    ["0x10", "digits"],
    ["NaN", "digits"],
    ["Infinity", "digits"],
    ["12.", "digits"],
    [".5", "digits"],
    ["10000000000.01", "too large"],
    ["10000000001", "too large"],
    ["99999999999999999999", "too large"],
  ])("refuses %j", (input, why) => {
    const res = parseRandsToCents(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.toLowerCase()).toContain(why);
  });

  it("never returns a fraction of a cent, whatever the float arithmetic would say", () => {
    for (const rands of ["0.07", "0.29", "1.15", "4.35", "8.2", "19.99", "1.005".slice(0, 4)]) {
      const res = parseRandsToCents(rands);
      expect(res.ok && Number.isInteger(res.cents)).toBe(true);
    }
    expect(parseRandsToCents("0.29")).toEqual({ ok: true, cents: 29 });
    expect(parseRandsToCents("4.35")).toEqual({ ok: true, cents: 435 });
  });
});

describe("parseQuantity", () => {
  it.each([
    ["1", "1"],
    ["12.5", "12.5"],
    ["12,5", "12.5"],
    ["0.001", "0.001"],
    ["1 000", "1000"],
    ["007", "7"],
    ["2.50", "2.5"],
  ])("%s is %s", (input, value) => {
    expect(parseQuantity(input)).toEqual({ ok: true, value });
  });

  it.each(["", "0", "0.000", "-1", "1.2345", "abc", "1e3", "1,000.5", "1000001", "12."])("refuses %j", (input) => {
    expect(parseQuantity(input).ok).toBe(false);
  });
});

describe("lineAmountCents: quantity times unit price, rounded half up to a cent", () => {
  it.each([
    ["1", 12345, 12345],
    ["2", 12345, 24690],
    ["1.5", 333, 500], // 499.5
    ["1.5", 332, 498], // exactly 498
    ["0.001", 499, 0], // 0.499
    ["0.001", 500, 1], // 0.5 rounds up
    ["12.345", 10000, 123450],
    ["3", 0, 0],
    ["0.5", 1, 1], // 0.5 of a cent rounds up
  ])("%s x %i cents = %i cents", (quantity, unit, expected) => {
    expect(lineAmountCents(quantity, unit)).toBe(expected);
  });

  it("is exact where floating point is not", () => {
    // 0.1 + 0.2 style traps: 4.35 x 100 and 1.005 x 1000 in floats are 434.99999999999994 and 1004.9999999999999
    expect(lineAmountCents("100", 435)).toBe(43500);
    expect(lineAmountCents("1000", 101)).toBe(101000);
    expect(lineAmountCents("0.1", 3)).toBe(0);
    expect(lineAmountCents("0.3", 5)).toBe(2); // 1.5 rounds up
  });

  it("allows an amount up to the cap and refuses one over it rather than overflow", () => {
    expect(MAX_AMOUNT_CENTS).toBe(1_000_000_000_000);
    expect(lineAmountCents("1", MAX_AMOUNT_CENTS)).toBe(MAX_AMOUNT_CENTS);
    expect(() => lineAmountCents("2", MAX_AMOUNT_CENTS)).toThrow(/too large/i);
    expect(() => lineAmountCents("1000000", MAX_AMOUNT_CENTS)).toThrow(/too large/i);
  });
});

describe("vatCents: 15 percent, rounded half up", () => {
  it("uses the South African standard rate", () => expect(SA_VAT_PERCENT).toBe(15));

  it.each([
    [0, 0],
    [1, 0], // 0.15
    [3, 0], // 0.45
    [4, 1], // 0.6
    [10, 2], // 1.5 rounds up
    [100, 15],
    [333, 50], // 49.95
    [12345, 1852], // 1851.75
    [1_000_000, 150_000],
  ])("VAT on %i cents is %i cents", (amount, vat) => expect(vatCents(amount)).toBe(vat));
});

describe("priceSchedule: totals from the lines, in cents", () => {
  const line = (over: Partial<ScheduleLine> = {}): ScheduleLine => ({ quantity: "2", unitPriceCents: 1000, ...over });

  it("adds line amounts and line VAT, so the lines always add up to the totals", () => {
    const res = priceSchedule([line({ quantity: "3", unitPriceCents: 333 }), line({ quantity: "1", unitPriceCents: 10 }), line({ quantity: "2", unitPriceCents: 1000 })]);
    expect(res.lines.map((l) => [l.amountCents, l.vatCents, l.totalCents])).toEqual([
      [999, 150, 1149], // 999 x 15% = 149.85
      [10, 2, 12], // 1.5 rounds up
      [2000, 300, 2300],
    ]);
    expect(res).toMatchObject({ subtotalCents: 3009, vatCents: 452, totalCents: 3461, priced: 3, complete: true });
    expect(res.subtotalCents + res.vatCents).toBe(res.totalCents);
    expect(res.lines.reduce((s, l) => s + l.vatCents!, 0)).toBe(res.vatCents);
  });

  it("is not complete while any line lacks a price or a quantity, and says how many are priced", () => {
    const res = priceSchedule([line(), line({ unitPriceCents: null }), line({ quantity: null })]);
    expect(res).toMatchObject({ priced: 1, complete: false, subtotalCents: 2000, vatCents: 300, totalCents: 2300 });
    expect(res.lines[1]).toMatchObject({ amountCents: null, vatCents: null, totalCents: null });
  });

  it("treats a price of zero as entered (no charge), not as missing", () => {
    const res = priceSchedule([line({ unitPriceCents: 0 })]);
    expect(res).toMatchObject({ priced: 1, complete: true, subtotalCents: 0, totalCents: 0 });
  });

  it("is not complete with no lines at all", () => {
    expect(priceSchedule([])).toMatchObject({ lines: [], priced: 0, complete: false, subtotalCents: 0, vatCents: 0, totalCents: 0 });
  });
});

describe("formatCents", () => {
  it.each([
    [0, "R 0.00"],
    [5, "R 0.05"],
    [123456, "R 1 234.56"],
    [100_000_000_00, "R 100 000 000.00"],
  ])("%i is %s", (cents, text) => {
    expect(formatCents(cents).replace(/ /g, " ")).toBe(text);
  });
});
