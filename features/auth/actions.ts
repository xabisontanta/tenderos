"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { registryPayload, slugify } from "@/lib/org/bootstrap";
import { rateLimit, toUserError } from "@/lib/actions";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { authRedirectUrl } from "@/lib/auth/urls";
import { createLogger } from "@/lib/log";
import { guardAuthAttempt } from "./guard";
import { fieldErrorsOf, textOf, type FormState } from "./form-state";

const log = createLogger({ module: "auth-actions" });

const TOO_MANY = "Too many attempts. Wait a moment and try again.";
const CHECK_EMAIL = "Check your email to confirm your account. If you already have an account, sign in or reset your password instead.";
const RESEND_SENT = "If that address is waiting for confirmation, a new link is on its way.";

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
  // Supabase reports an unconfirmed address only after the password was right,
  // so naming it here tells a stranger nothing.
  if (error?.code === "email_not_confirmed")
    return { error: "Confirm your email address first. We sent you a link when you signed up.", code: "email_not_confirmed", values };
  // Generic message: do not reveal whether the account exists.
  if (error) return { error: error.status === 429 ? TOO_MANY : "Invalid email or password", values };
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
  // With email confirmation on, an address that is already registered must look
  // exactly like a new one. Supabase answers with an obfuscated user and no
  // error when it can, but it can also answer "user already exists" or "email
  // recently sent" (a 60 second resend interval applies per address); those
  // are folded into the same reply, because telling them apart would let
  // anyone test which addresses have accounts.
  if (error && error.code !== "user_already_exists" && error.code !== "over_email_send_rate_limit")
    return { error: error.status === 429 ? TOO_MANY : "Could not create the account", values };
  // A session only comes back when the server confirmed the address itself
  // (local development without confirmations). Hosted projects always confirm.
  if (!error && data.session) redirect("/onboarding");
  return { message: CHECK_EMAIL, code: "confirmation_sent", values };
}

/**
 * Sends the confirmation email again. The reply never depends on whether the
 * address exists, is already confirmed, or was emailed a moment ago (that last
 * one is capped at one per 60 seconds), so this cannot be used to probe accounts.
 */
export async function resendConfirmation(_: FormState, formData: FormData): Promise<FormState> {
  const values = { email: textOf(formData.get("email")) };
  const parsed = emailSchema.safeParse(values);
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error), values };

  const guard = await guardAuthAttempt("resend", parsed.data.email, formData);
  if (!guard.ok) return { error: guard.error, values };

  const supabase = await getServerSupabase();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: parsed.data.email,
    options: {
      emailRedirectTo: authRedirectUrl("/auth/callback", { next: "/onboarding" }),
      ...(guard.captchaToken ? { captchaToken: guard.captchaToken } : {}),
    },
  });
  // Not shown to the visitor, but worth knowing about if mail stops flowing.
  if (error) log.warn("resend confirmation failed", { code: error.code, status: error.status });
  return { message: RESEND_SENT, code: "confirmation_sent", values };
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
