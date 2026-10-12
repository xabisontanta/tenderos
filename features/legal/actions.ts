"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { toUserError } from "@/lib/actions";
import { consentOriginHmac } from "@/lib/auth/rate-limit";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { getServerSupabase } from "@/lib/supabase/server";
import type { FormState } from "@/features/auth/form-state";

/**
 * Records that the signed-in user accepts the terms and privacy notice now in
 * force, for people who did not accept them at sign-up or when a new version
 * was published. The database refuses versions that are not the current ones.
 */
export async function acceptLegalDocuments(_: FormState, formData: FormData): Promise<FormState> {
  if (formData.get("accept") !== "on") return { fieldErrors: { accept: "Tick the box to accept the Terms of Service and Privacy Notice and continue" } };

  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const origin = consentOriginHmac(await headers());
  const { error } = await supabase.rpc("accept_legal", {
    p_terms_version: LEGAL_VERSIONS.terms,
    p_privacy_version: LEGAL_VERSIONS.privacy,
    ...(origin ? { p_ip_hmac: origin } : {}),
  });
  if (error) return { error: toUserError(error, "Could not record your acceptance") };
  redirect(safeRedirectPath(formData.get("next")));
}
