import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect } from "@playwright/test";
import { registryPayload } from "../../../lib/org/bootstrap";
import { LEGAL_VERSIONS } from "../../../lib/legal/versions";

/** The service-role client the tests use to set accounts up and to look behind the app. Local stack only. */
export function adminClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface OrgOwner {
  userId: string;
  orgId: string;
  email: string;
  password: string;
  orgName: string;
}

/**
 * A confirmed user who owns a new organisation and has accepted the terms, made through the API rather than the sign-up
 * form so a test that is about something else does not repeat it. The caller signs in through the browser.
 */
export async function createOrgOwner(options: { fullName?: string; orgName?: string; emailPrefix?: string } = {}): Promise<OrgOwner> {
  const { fullName = "Sipho Dlamini", orgName = `Khumalo Civils ${Date.now()}`, emailPrefix = "owner" } = options;
  const email = `${emailPrefix}-${randomUUID().slice(0, 8)}@tenderos.test`;
  const password = `Pw-${randomUUID()}`;
  const admin = adminClient();
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
  if (created.error) throw created.error;

  const asUser = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  expect((await asUser.auth.signInWithPassword({ email, password })).error).toBeNull();
  expect((await asUser.rpc("accept_legal", { p_terms_version: LEGAL_VERSIONS.terms, p_privacy_version: LEGAL_VERSIONS.privacy })).error).toBeNull();
  const boot = await admin.rpc("bootstrap_organisation", {
    p_user_id: created.data.user.id,
    p_name: orgName,
    p_slug: `e2e-${randomUUID().slice(0, 12)}`,
    ...registryPayload(),
  } as never);
  expect(boot.error).toBeNull();
  return { userId: created.data.user.id, orgId: boot.data as unknown as string, email, password, orgName };
}

/** Does this stack's Auth server accept authenticator-app (TOTP) enrolment? A container made from an older config does not. */
export async function totpEnabled(): Promise<boolean> {
  const user = await createOrgOwner({ emailPrefix: "probe", orgName: `Probe ${Date.now()}` });
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await client.auth.signInWithPassword({ email: user.email, password: user.password });
  const { data, error } = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "probe" });
  if (error) return error.code !== "mfa_totp_enroll_not_enabled" ? Promise.reject(error) : false;
  await client.auth.mfa.unenroll({ factorId: data.id });
  return true;
}
