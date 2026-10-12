import { z } from "zod";

export const pricingLineSchema = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  unit_price_zar: z.number().nullable(),
  source: z.enum(["SUPPLIER_QUOTE", "RATE_CARD", "MISSING_INFORMATION"]),
  /** Item or clause number as the tender prints it. */
  item_ref: z.string().optional(),
  /** The analysed requirement this line comes from. */
  requirement_id: z.string().optional(),
  /** The tender's own printed line, copied from the analysed requirement's verified quote. */
  quote: z.string().optional(),
  page: z.number().int().optional(),
  /** The bidder would normally need a supplier's quotation to price this line. */
  supplier_quote_likely: z.boolean().optional(),
  warning: z.string().optional(),
});

export const vatTreatmentSchema = z.object({
  rate: z.number(),
  treatment: z.enum(["EXCLUSIVE", "INCLUSIVE", "NOT_STATED"]),
  status: z.enum(["STATED", "REQUIRES_CONFIRMATION"]),
  /** The analysed requirement that states the treatment. */
  requirement_id: z.string().optional(),
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
  vat: vatTreatmentSchema.optional(),
  /** True when a model structured the lines. It never produces a price. */
  ai_generated: z.boolean().optional(),
});
export type PricingOutput = z.infer<typeof pricingOutputSchema>;
export type PricingLine = z.infer<typeof pricingLineSchema>;

// What the model fills in. There is deliberately no field for a price, rate, amount or total.
export const pricingModelSchema = z.object({
  lines: z.array(
    z.object({
      requirement_id: z.string().describe("The id, exactly as written in brackets, of the requirement that is this schedule line"),
      item_ref: z.string().describe("Item or clause number as printed; empty string if none"),
      description: z.string().describe("What is to be supplied or done, as the tender describes it"),
      quantity: z.number().nullable().describe("The quantity only if the printed line states one; otherwise null"),
      unit: z.string().describe("The unit as printed (m, m2, each, sum); empty string if none"),
      supplier_quote_likely: z.boolean().describe("True when a bidder would normally need a supplier's or subcontractor's quotation for this line"),
    }),
  ),
  vat: z.object({
    treatment: z.enum(["EXCLUSIVE", "INCLUSIVE", "NOT_STATED"]).describe("Whether the tender says figures are quoted exclusive or inclusive of VAT; NOT_STATED if no requirement says"),
    requirement_id: z.string().describe("The id of the requirement that says so; empty string if NOT_STATED"),
  }),
  notes: z.array(z.string()).describe("Short remarks for the person completing the schedule, taken from the requirements"),
});
export type PricingModel = z.infer<typeof pricingModelSchema>;
