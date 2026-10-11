import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { getServerSupabase } from "@/lib/supabase/server";
import { pendingLegalAcceptances } from "@/lib/legal/status";
import type { Database } from "@/types/database";

export type OrgRole = Database["public"]["Enums"]["org_role"];

export interface AppContext {
  userId: string;
  email: string | null;
  fullName: string | null;
  organisation: { id: string; name: string; slug: string };
  role: OrgRole;
  settings: Database["public"]["Tables"]["system_settings"]["Row"];
}

/**
 * Resolves the signed-in user and their organisation. Redirects to /login or
 * /onboarding when either is missing. Cached per request.
 */
export const requireContext = cache(async (): Promise<AppContext> => {
  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Terms or privacy notice published since this user last accepted, or never accepted.
  if ((await pendingLegalAcceptances(supabase)).length > 0) redirect("/legal/accept");

  const { data: membership } = await supabase
    .from("organisation_members")
    .select("role, organisations(id, name, slug)")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (!membership?.organisations) redirect("/onboarding");

  const org = membership.organisations as unknown as AppContext["organisation"];
  const [{ data: profile }, { data: settings }] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
    supabase.from("system_settings").select("*").eq("organisation_id", org.id).single(),
  ]);
  if (!settings) throw new Error("Organisation settings missing");

  return {
    userId: user.id,
    email: user.email ?? null,
    fullName: profile?.full_name ?? null,
    organisation: org,
    role: membership.role,
    settings,
  };
});

export function canOperate(role: OrgRole) {
  return role === "owner" || role === "admin" || role === "operator";
}

export function canAdminister(role: OrgRole) {
  return role === "owner" || role === "admin";
}
