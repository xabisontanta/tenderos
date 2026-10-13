"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fieldErrorsOf, type FormState } from "@/features/auth/form-state";
import { profileFocusSchema, readProfileFocus } from "@/features/company/schema";
import { toUserError } from "@/lib/actions";
import { canAdminister, requireContext } from "@/lib/data/context";
import { getServerSupabase } from "@/lib/supabase/server";

/** Marks the wizard as done (finished or skipped) and sends the user to Discover. */
async function finish(orgId: string) {
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("complete_onboarding", { p_org: orgId });
  if (error) return { error: toUserError(error, "Could not finish the setup") };
  revalidatePath("/");
  revalidatePath("/discover");
  revalidatePath("/company");
  redirect("/discover");
}

/**
 * Saves what the setup wizard collected: sectors, provinces, CIDB grade and
 * keywords. Every part is optional and only what was filled in is written, so
 * finishing with blanks cannot erase what the company page already holds, and
 * finishing with nothing at all is the same as skipping. Provinces are also
 * watched by the Tender Scout, with automatic workflows off: the wizard never
 * switches them on.
 */
export async function saveOnboardingProfile(_: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireContext();
  if (!canAdminister(ctx.role)) return { error: "Only owners and admins can set up the company profile" };

  const focus = readProfileFocus(formData);
  // Echoed back on a problem so the wizard shows what was typed (lists are comma separated; entries never contain commas).
  const values = {
    sectors: focus.sectors.join(", "),
    provinces: focus.provinces.join(","),
    cidb_grade: focus.cidb_grade ?? "",
    keywords: focus.keywords.join(", "),
  };
  const parsed = profileFocusSchema.safeParse(focus);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values };

  const supabase = await getServerSupabase();
  const { cidb_grade, sectors, provinces, keywords } = parsed.data;
  const profile = {
    ...(sectors.length ? { sectors } : {}),
    ...(provinces.length ? { provinces } : {}),
    ...(cidb_grade ? { cidb_grade } : {}),
    ...(keywords.length ? { keywords } : {}),
  };
  if (Object.keys(profile).length > 0) {
    const { error } = await supabase.from("company_profiles").upsert({ organisation_id: ctx.organisation.id, ...profile }, { onConflict: "organisation_id" });
    if (error) return { error: toUserError(error, "Could not save the company profile"), values };
  }
  if (provinces.length > 0) {
    const { error } = await supabase.rpc("set_watched_provinces", { p_org: ctx.organisation.id, p_provinces: provinces, p_auto_run: false });
    if (error) return { error: toUserError(error, "Saved your profile, but could not save the provinces to watch"), values };
  }
  return (await finish(ctx.organisation.id)) ?? { values };
}

/** Skips the wizard: nothing is saved beyond the fact that it was seen, and the account works as it is. */
export async function skipOnboarding(_prev?: FormState, _formData?: FormData): Promise<FormState> {
  const ctx = await requireContext();
  if (!canAdminister(ctx.role)) redirect("/");
  return (await finish(ctx.organisation.id)) ?? {};
}
