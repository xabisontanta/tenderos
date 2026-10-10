import { z } from "zod";

export const pricingLineSchema = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  unit_price_zar: z.number().nullable(),
  source: z.enum(["SUPPLIER_QUOTE", "RATE_CARD", "MISSING_INFORMATION"]),
});

export const pricingOutputSchema = z.object({
  currency: z.literal("ZAR"),
  vat_rate: z.number(),
  lines: z.array(pricingLineSchema),
  subtotal_zar: z.number().nullable(),
  status: z.enum(["READY_FOR_APPROVAL", "REQUIRES_CONFIRMATION"]),
  notes: z.array(z.string()),
  requires_human_approval: z.literal(true),
  simulated: z.boolean(),
});
export type PricingOutput = z.infer<typeof pricingOutputSchema>;
export type PricingLine = z.infer<typeof pricingLineSchema>;
