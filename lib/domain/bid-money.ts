/**
 * Money for the pricing schedule, in whole cents. Prices are always entered by a person (AGENTS.md section 13); this is
 * the arithmetic that turns what they type into line and bid totals. Everything is integer arithmetic (BigInt inside), so a
 * float never touches a rand amount. The database computes the same figures (generated columns on bid_pricing_lines and
 * bid_pricing_totals, migration 072); tests/integration/bid-content.test.ts checks the two agree on the same cases.
 */

/** South African standard VAT rate, in percent. */
export const SA_VAT_PERCENT = 15;
/** Largest unit price or line amount: R10 000 000 000. Keeps every total far inside what a JavaScript number holds exactly. */
export const MAX_AMOUNT_CENTS = 1_000_000_000_000;
export const MAX_UNIT_PRICE_CENTS = MAX_AMOUNT_CENTS;
/** Largest quantity on one line. */
export const MAX_QUANTITY = 1_000_000;

export type Parsed<T> = ({ ok: true } & T) | { ok: false; error: string };

const AMOUNT_HELP = "Use digits only, with a decimal point or comma for cents, for example 1234.56";

/** Spaces, no-break spaces and a leading R are only decoration. */
const tidy = (input: string) => input.replace(/[\s  ]/g, "").replace(/^r/i, "");

/** What a person typed as rands to whole cents. Up to two decimals; a comma or a point may be the decimal mark. */
export function parseRandsToCents(input: string): Parsed<{ cents: number }> {
  if (typeof input !== "string" || input.trim() === "") return { ok: false, error: "Enter an amount" };
  const text = tidy(input);
  if (text.startsWith("-")) return { ok: false, error: "An amount cannot be negative" };
  const match = /^(\d{1,30})(?:[.,](\d{1,2}))?$/.exec(text);
  if (!match) return { ok: false, error: AMOUNT_HELP };
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  if (cents > BigInt(MAX_UNIT_PRICE_CENTS)) return { ok: false, error: "That amount is too large" };
  return { ok: true, cents: Number(cents) };
}

/** A quantity with up to three decimals, normalised ("2.50" is "2.5"). */
export function parseQuantity(input: string): Parsed<{ value: string }> {
  if (typeof input !== "string" || input.trim() === "") return { ok: false, error: "Enter a quantity" };
  const text = tidy(input);
  if (text.startsWith("-")) return { ok: false, error: "A quantity cannot be negative" };
  const match = /^(\d{1,7})(?:[.,](\d{1,3}))?$/.exec(text);
  if (!match) return { ok: false, error: "Use digits only, with up to three decimals, for example 12.5" };
  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (whole === 0n && fraction === "") return { ok: false, error: "A quantity must be more than zero" };
  if (whole > BigInt(MAX_QUANTITY) || (whole === BigInt(MAX_QUANTITY) && fraction !== "")) return { ok: false, error: "That quantity is too large" };
  return { ok: true, value: fraction ? `${whole}.${fraction}` : String(whole) };
}

/** A quantity as thousandths, exactly. Accepts the normalised string or a number with at most three decimals. */
function milli(quantity: string | number): bigint {
  const text = typeof quantity === "number" ? String(quantity) : quantity;
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (!m) throw new RangeError(`Not a quantity with at most three decimals: ${text}`);
  return BigInt(m[1]) * 1000n + BigInt((m[2] ?? "").padEnd(3, "0") || "0");
}

/** Quantity times unit price, rounded half up to a whole cent. Throws when the amount is over the cap. */
export function lineAmountCents(quantity: string | number, unitPriceCents: number): number {
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0) throw new RangeError("A unit price must be a whole number of cents, not negative");
  const amount = (milli(quantity) * BigInt(unitPriceCents) + 500n) / 1000n;
  if (amount > BigInt(MAX_AMOUNT_CENTS)) throw new RangeError("That line amount is too large");
  return Number(amount);
}

/** VAT on an amount, rounded half up to a whole cent. */
export function vatCents(amountCents: number): number {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new RangeError("An amount must be a whole number of cents, not negative");
  return Number((BigInt(amountCents) * BigInt(SA_VAT_PERCENT) + 50n) / 100n);
}

export interface ScheduleLine {
  /** As typed or printed; null when the tender prints none and nobody has entered one. */
  quantity: string | null;
  unitPriceCents: number | null;
}

export interface PricedLine {
  amountCents: number | null;
  vatCents: number | null;
  totalCents: number | null;
}

export interface PricedSchedule {
  lines: PricedLine[];
  /** Lines with both a quantity and a unit price (a price of zero counts as entered). */
  priced: number;
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  /** At least one line, and every line priced. */
  complete: boolean;
}

/**
 * Line and bid totals. VAT is worked out on each line and the bid's VAT is the sum of the lines, so the lines shown always
 * add up to the totals shown. Lines without a price or a quantity count for nothing in the totals and keep `complete` false.
 */
export function priceSchedule(lines: readonly ScheduleLine[]): PricedSchedule {
  let subtotal = 0;
  let vat = 0;
  let priced = 0;
  const out = lines.map((l): PricedLine => {
    if (l.quantity === null || l.unitPriceCents === null) return { amountCents: null, vatCents: null, totalCents: null };
    const amount = lineAmountCents(l.quantity, l.unitPriceCents);
    const lineVat = vatCents(amount);
    subtotal += amount;
    vat += lineVat;
    priced++;
    return { amountCents: amount, vatCents: lineVat, totalCents: amount + lineVat };
  });
  return { lines: out, priced, subtotalCents: subtotal, vatCents: vat, totalCents: subtotal + vat, complete: lines.length > 0 && priced === lines.length };
}

/** "R 1 234.56". Always two decimals. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}R ${whole}.${String(abs % 100).padStart(2, "0")}`;
}
