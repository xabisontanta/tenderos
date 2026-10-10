import { z } from "zod";
import { PROVINCES } from "@/lib/format";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const optionalDate = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (v === "") return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Invalid date" });
      return z.NEVER;
    }
    return d.toISOString();
  })
  .nullable()
  .optional();

export const tenderInputSchema = z
  .object({
    title: z.string().trim().min(3, "Title is required").max(300),
    issuing_organisation: z.string().trim().min(2, "Issuing organisation is required").max(200),
    reference_number: optionalText(120),
    description: optionalText(10000),
    province: z.enum(PROVINCES.map((p) => p.value) as [string, ...string[]]),
    sector: optionalText(120),
    estimated_value_zar: z
      .string()
      .trim()
      .transform((v, ctx) => {
        if (v === "") return null;
        const n = Number(v.replaceAll(/[\s,R]/g, ""));
        if (!Number.isFinite(n) || n < 0) {
          ctx.addIssue({ code: "custom", message: "Estimated value must be a positive number" });
          return z.NEVER;
        }
        return n;
      })
      .nullable()
      .optional(),
    published_at: optionalDate,
    closing_at: z
      .string()
      .trim()
      .min(1, "Closing date is required")
      .transform((v, ctx) => {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) {
          ctx.addIssue({ code: "custom", message: "Invalid closing date" });
          return z.NEVER;
        }
        return d.toISOString();
      }),
    briefing_at: optionalDate,
    briefing_compulsory: z.boolean(),
    briefing_location: optionalText(300),
    questions_deadline_at: optionalDate,
    submission_method: z.enum(["ELECTRONIC_PORTAL", "EMAIL", "PHYSICAL", "UNKNOWN"]),
    submission_destination: optionalText(500),
    source_url: optionalText(2000).refine((v) => !v || /^https?:\/\//.test(v), "Source URL must start with http:// or https://"),
    is_simulation: z.boolean(),
  })
  .refine((v) => !v.briefing_at || v.briefing_at <= v.closing_at, { message: "Briefing must be before closing", path: ["briefing_at"] })
  .refine((v) => !v.published_at || v.published_at <= v.closing_at, { message: "Publication must be before closing", path: ["published_at"] });
