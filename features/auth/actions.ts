"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { registryPayload, slugify } from "@/lib/org/bootstrap";
import { rateLimit, toUserError } from "@/lib/actions";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { authRedirectUrl } from "@/lib/auth/urls";
import { guardAuthAttempt } from "./guard";
import { fieldErrorsOf, textOf, type FormState } from "./form-state";

const emailField = z.string().trim().toLowerCase().email("Enter a valid email address").max(254);

const credentials = z.object({
  email: emailField,
  password: z.string().min(1, "Enter your password").max(200),
});

export async function signIn(_: FormState, formData: FormData): Promise<FormState> {
  const values = { email: textOf(formData.get("email")) };
  const parsed = credentials.safeParse({ email: values.email, password: formData.get("password") });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values };

  const guard = await guardAuthAttempt("signin", parsed.data.email, formData);
  if (!guard.ok) return { error: guard.error, values };

  const supabase = await getServerSupabase();
  const { error } = await supabase.auth.signInWithPassword({
    ...parsed.data,
    ...(guard.captchaToken ? { options: { captchaToken: guard.captchaToken } } : {}),
  });
  // Generic message: do not reveal whether the account exists.
  if (error) return { error: error.status === 429 ? "Too many attempts. Wait a moment and try again." : "Invalid email or password", values };
  redirect(safeRedirectPath(formData.get("next")));
}

const signUpSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your name").max(120),
  email: emailField,
  password: z
    .string()
    .min(12, "Use at least 12 characters")
    .max(200)
    .regex(/[A-Za-z]/, "Include a letter")
    .regex(/[0-9]/, "Include a number"),
});

export async function signUp(_: FormState, formData: FormData): Promise<FormState> {
  const values = { fullName: textOf(formData.get("fullName")), email: textOf(formData.get("email")) };
  const parsed = signUpSchema.safeParse({ ...values, password: formData.get("password") });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values };

  const guard = await guardAuthAttempt("signup", parsed.data.email, formData);
  if (!guard.ok) return { error: guard.error, values };

  const supabase = await getServerSupabase();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: authRedirectUrl("/auth/callback", { next: "/onboarding" }),
      ...(guard.captchaToken ? { captchaToken: guard.captchaToken } : {}),
    },
  });
  if (error) return { error: error.status === 429 ? "Too many attempts. Wait a moment and try again." : "Could not create the account", values };
  // Supabase sends nothing when the email is already registered and still
  // reports success, so the message covers both cases without revealing which.
  if (!data.session)
    return {
      message: "Check your email to confirm your account. No email? This address may already have an account: sign in or reset your password.",
    };
  redirect("/onboarding");
}

const emailSchema = z.object({ email: emailField });

export async function requestPasswordReset(_: FormState, formData: FormData): Promise<FormState> {
  const values = { email: textOf(formData.get("email")) };
  const parsed = emailSchema.safeParse(values);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values };

  const guard = await guardAuthAttempt("reset", parsed.data.email, formData);
  if (!guard.ok) return { error: guard.error, values };

  const supabase = await getServerSupabase();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: authRedirectUrl("/auth/callback", { next: "/reset-password" }),
    ...(guard.captchaToken ? { captchaToken: guard.captchaToken } : {}),
  });
  if (error?.status === 429) return { error: "Too many attempts. Wait a moment and try again.", values };
  // Same answer whether or not the account exists.
  return { message: "If an account exists for that email, a reset link is on its way." };
}

const newPasswordSchema = z.object({ password: signUpSchema.shape.password });

export async function updatePassword(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = newPasswordSchema.safeParse({ password: formData.get("password") });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };
  const supabase = await getServerSupabase();
  const limited = await rateLimit(supabase, "auth.password_update", 5, 3600);
  if (limited) return { error: limited };
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
  const values = { name: textOf(formData.get("name")) };
  const parsed = orgSchema.safeParse(values);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values };

  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error: rlError } = await supabase.rpc("hit_rate_limit", { p_action: "org.create", p_max: 5, p_window_seconds: 3600 });
  if (rlError) return { error: toUserError(rlError, "Too many requests"), values };

  const slug = `${slugify(parsed.data.name)}-${crypto.randomUUID().slice(0, 6)}`;
  const { error } = await getAdminSupabase().rpc("bootstrap_organisation", {
    p_user_id: user.id,
    p_name: parsed.data.name,
    p_slug: slug,
    ...registryPayload(),
  } as never);
  if (error) return { error: toUserError(error, "Could not create the organisation"), values };
  redirect("/discover");
}

export async function signOut(): Promise<void> {
  const supabase = await getServerSupabase();
  await supabase.auth.signOut();
  redirect("/login");
}
