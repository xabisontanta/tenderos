"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { canAdminister, requireContext } from "@/lib/data/context";
import { toUserError } from "@/lib/actions";
import { WATCHABLE_PROVINCES } from "@/features/discovery/provinces";

export interface CompanyFormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
}

const blank = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

const schema = z.object({
  legal_name: z.string().min(2).max(200).nullable(),
  registration_number: z.string().max(40).nullable(),
  csd_number: z
    .string()
    .regex(/^MAAA\d{7}$/, "CSD numbers look like MAAA0123456")
    .nullable(),
  tax_pin: z.string().min(6, "Enter the full PIN").max(40).nullable(),
  tax_pin_expires_at: z.iso.date("Use a date").nullable(),
  bbbee_level: z.coerce.number().int().min(1).max(8).nullable(),
  bbbee_expires_at: z.iso.date("Use a date").nullable(),
  cidb_grade: z
    .string()
    .regex(/^[1-9][A-Z]{1,3}$/, "Use the grade as printed, e.g. 5CE")
    .nullable(),
  sectors: z.array(z.string().min(2).max(120)).max(30),
  provinces: z.array(z.enum(WATCHABLE_PROVINCES.map((p) => p.value) as [string, ...string[]])),
  max_contract_value_zar: z.coerce.number().positive("Must be more than zero").nullable(),
  authorised_signatory: z.string().min(2).max(120).nullable(),
  trading_name: z.string().min(2).max(200).nullable(),
  vat_number: z
    .string()
    .regex(/^4\d{9}$/, "SA VAT numbers are 10 digits starting with 4")
    .nullable(),
  contact_person: z.string().min(2).max(120).nullable(),
  contact_email: z.string().email("Enter a valid email address").max(254).nullable(),
  contact_phone: z
    .string()
    .regex(/^\+?[0-9 ()-]{9,20}$/, "Enter a phone number, e.g. 011 555 0100")
    .nullable(),
  physical_address: z.string().min(5).max(500).nullable(),
  postal_address: z.string().min(5).max(500).nullable(),
  website: z
    .string()
    .regex(/^https?:\/\/\S{3,200}$/, "Start with https://")
    .nullable(),
});

export async function saveCompanyProfile(_prev: CompanyFormState, formData: FormData): Promise<CompanyFormState> {
  const ctx = await requireContext();
  if (!canAdminister(ctx.role)) return { error: "Only owners and admins can change the company profile" };
  const parsed = schema.safeParse({
    legal_name: blank(formData.get("legal_name")),
    registration_number: blank(formData.get("registration_number")),
    csd_number: blank(formData.get("csd_number"))?.toUpperCase() ?? null,
    tax_pin: blank(formData.get("tax_pin")),
    tax_pin_expires_at: blank(formData.get("tax_pin_expires_at")),
    bbbee_level: blank(formData.get("bbbee_level")),
    bbbee_expires_at: blank(formData.get("bbbee_expires_at")),
    cidb_grade: blank(formData.get("cidb_grade"))?.toUpperCase() ?? null,
    sectors: (blank(formData.get("sectors")) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    provinces: formData.getAll("provinces").map(String),
    max_contract_value_zar: blank(formData.get("max_contract_value_zar"))?.replace(/[\s,R]/g, "") ?? null,
    authorised_signatory: blank(formData.get("authorised_signatory")),
    trading_name: blank(formData.get("trading_name")),
    vat_number: blank(formData.get("vat_number"))?.replace(/\s/g, "") ?? null,
    contact_person: blank(formData.get("contact_person")),
    contact_email: blank(formData.get("contact_email"))?.toLowerCase() ?? null,
    contact_phone: blank(formData.get("contact_phone")),
    physical_address: blank(formData.get("physical_address")),
    postal_address: blank(formData.get("postal_address")),
    website: blank(formData.get("website")),
  });
  if (!parsed.success) {
    return { fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])) };
  }
  const supabase = await getServerSupabase();
  const { error } = await supabase.from("company_profiles").upsert({ organisation_id: ctx.organisation.id, ...parsed.data }, { onConflict: "organisation_id" });
  if (error) return { error: toUserError(error, "Could not save the company profile") };
  revalidatePath("/company");
  revalidatePath("/discover");
  return { ok: true };
}
