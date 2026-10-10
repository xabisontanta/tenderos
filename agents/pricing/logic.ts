import type { PricingLine } from "./schema";

/** South African standard VAT rate. */
export const SA_VAT_RATE = 0.15;

/** Sums line totals; returns null if any line lacks a confirmed quantity or price. */
export function subtotal(lines: PricingLine[]): number | null {
  let total = 0;
  for (const l of lines) {
    if (l.quantity == null || l.unit_price_zar == null) return null;
    total += l.quantity * l.unit_price_zar;
  }
  return Math.round(total * 100) / 100;
}

export function withVat(amount: number, rate = SA_VAT_RATE): number {
  return Math.round(amount * (1 + rate) * 100) / 100;
}
