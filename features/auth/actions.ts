"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { registryPayload, slugify } from "@/lib/org/bootstrap";
import { toUserError } from "@/lib/actions";
import { safeRedirectPath } from "@/lib/safe-redirect";

export interface FormState {
  error?: string;
  message?: string;
}

const credentials = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
  password: z.string().min(1, "Enter your password").max(200),
});

export async function signIn(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = credentials.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const supabase = await getServerSupabase();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  // Generic message: do not reveal whether the account exists.
  if (error) return { error: error.status === 429 ? "Too many attempts. Wait a moment and try again." : "Invalid email or password" };
  redirect(safeRedirectPath(formData.get("next")));
}

const signUpSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your name").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
  password: z
    .string()
    .min(12, "Use at least 12 characters")
    .max(200)
    .regex(/[A-Za-z]/, "Include a letter")
    .regex(/[0-9]/, "Include a number"),
});

export async function signUp(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = signUpSchema.safeParse({
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const supabase = await getServerSupabase();
  const origin = (await headers()).get("origin") ?? process.env.APP_URL ?? "";
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { data: { full_name: parsed.data.fullName }, emailRedirectTo: `${origin}/auth/callback` },
  });
  if (error) return { error: error.status === 429 ? "Too many attempts. Wait a moment and try again." : "Could not create the account" };
  // Supabase sends nothing when the email is already registered and still
  // reports success, so the message covers both cases without revealing which.
  if (!data.session)
    return {
      message: "Check your email to confirm your account. No email? This address may already have an account: sign in or reset your password.",
    };
  redirect("/onboarding");
}

const emailSchema = z.object({ email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254) });

export async function requestPasswordReset(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = emailSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const supabase = await getServerSupabase();
  const origin = (await headers()).get("origin") ?? process.env.APP_URL ?? "";
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origin}/auth/callback?next=/reset-password`,
  });
  if (error?.status === 429) return { error: "Too many attempts. Wait a moment and try again." };
  // Same answer whether or not the account exists.
  return { message: "If an account exists for that email, a reset link is on its way." };
}

const newPasswordSchema = z.object({ password: signUpSchema.shape.password });

export async function updatePassword(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = newPasswordSchema.safeParse({ password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const supabase = await getServerSupabase();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { error: "Could not update the password. Open the reset link again." };
  redirect("/");
}

const orgSchema = z.object({ name: z.string().trim().min(2, "Enter your company name").max(120) });

/**
 * Creates the user's organisation and installs the agent registry. The
 * caller is authenticated first; the service-role call is limited to this
 * single bootstrap function, which itself refuses users that already have
 * an organisation.
 */
export async function createOrganisation(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = orgSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error: rlError } = await supabase.rpc("hit_rate_limit", { p_action: "org.create", p_max: 5, p_window_seconds: 3600 });
  if (rlError) return { error: toUserError(rlError, "Too many requests") };

  const slug = `${slugify(parsed.data.name)}-${crypto.randomUUID().slice(0, 6)}`;
  const { error } = await getAdminSupabase().rpc("bootstrap_organisation", {
    p_user_id: user.id,
    p_name: parsed.data.name,
    p_slug: slug,
    ...registryPayload(),
  } as never);
  if (error) return { error: toUserError(error, "Could not create the organisation") };
  redirect("/discover");
}

export async function signOut(): Promise<void> {
  const supabase = await getServerSupabase();
  await supabase.auth.signOut();
  redirect("/login");
}
