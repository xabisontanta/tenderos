"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { requireContext } from "@/lib/data/context";
import { rateLimit, type ActionResult } from "@/lib/actions";
import { cleanTotpCode, isQrDataUrl } from "@/lib/auth/mfa";
import { mfaErrorMessage } from "@/lib/auth/mfa-errors";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { createLogger } from "@/lib/log";
import type { FormState } from "@/features/auth/form-state";

const log = createLogger({ module: "mfa-actions" });

const idSchema = z.string().uuid("Choose an authenticator");
const nameSchema = z.string().trim().max(60, "Keep the name under 60 characters");
const BAD_CODE = "Enter the six digits shown in your authenticator app.";
const DEFAULT_NAME = "Authenticator app";

/** Six wrong guesses a minute are already throttled by Supabase; this adds a per-person limit that counts every attempt. */
async function limitVerify(supabase: Awaited<ReturnType<typeof getServerSupabase>>): Promise<string | null> {
  return rateLimit(supabase, "mfa.verify", 10, 900);
}

/**
 * Challenges the chosen factor and checks the code. Success turns the session into aal2 (Supabase Auth hands back a
 * new session, which the server client stores in the cookies), and the person goes on to the page they asked for.
 */
export async function verifyChallenge(_: FormState, formData: FormData): Promise<FormState> {
  const code = cleanTotpCode(formData.get("code"));
  if (!code) return { fieldErrors: { code: BAD_CODE } };
  const factor = idSchema.safeParse(formData.get("factorId"));
  if (!factor.success) return { error: "Choose which authenticator to use." };

  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const limited = await limitVerify(supabase);
  if (limited) return { error: limited };

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: factor.data });
  if (challengeError || !challenge) {
    log.warn("mfa challenge failed", { code: challengeError?.code ?? "none" });
    return { error: mfaErrorMessage(challengeError, "Could not start the check. Try again in a moment.") };
  }
  const { error } = await supabase.auth.mfa.verify({ factorId: factor.data, challengeId: challenge.id, code });
  if (error) {
    log.info("mfa code refused", { code: error.code ?? "none" });
    return { error: mfaErrorMessage(error, "Could not check the code. Try again in a moment."), fieldErrors: { code: "Check the code and try again." } };
  }
  redirect(safeRedirectPath(formData.get("next")));
}

/**
 * Starts adding an authenticator app: removes any enrolment that was begun and never finished (its name would
 * otherwise be taken), then asks Supabase Auth for a secret and a QR code. They are returned to the page that shows
 * them to the person who asked, and never stored or logged by TenderOS.
 */
export async function startEnrolment(friendlyName: string): Promise<ActionResult<{ factorId: string; qrCode: string; secret: string }>> {
  await requireContext();
  const name = nameSchema.safeParse(friendlyName ?? "");
  if (!name.success) return { ok: false, error: name.error.issues[0].message };

  const supabase = await getServerSupabase();
  const limited = await rateLimit(supabase, "mfa.enroll", 10, 3600);
  if (limited) return { ok: false, error: limited };

  const listed = await supabase.auth.mfa.listFactors();
  for (const f of listed.data?.all ?? []) {
    if (f.factor_type === "totp" && f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
  }

  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: name.data || DEFAULT_NAME, issuer: "TenderOS" });
  if (error || !data) {
    log.warn("mfa enrol failed", { code: error?.code ?? "none" });
    return { ok: false, error: mfaErrorMessage(error, "Could not start setting up your authenticator. Try again in a moment.") };
  }
  if (!isQrDataUrl(data.totp.qr_code) || !data.totp.secret) {
    log.error("mfa enrol answered with something unexpected");
    return { ok: false, error: "Could not start setting up your authenticator. Try again in a moment." };
  }
  return { ok: true, data: { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret } };
}

/** The first code from the app proves it was set up properly; the factor is switched on and this session becomes aal2. */
export async function confirmEnrolment(factorId: string, code: string): Promise<ActionResult> {
  await requireContext();
  const id = idSchema.safeParse(factorId);
  if (!id.success) return { ok: false, error: id.error.issues[0].message };
  const clean = cleanTotpCode(code);
  if (!clean) return { ok: false, error: BAD_CODE };

  const supabase = await getServerSupabase();
  const limited = await limitVerify(supabase);
  if (limited) return { ok: false, error: limited };

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: id.data });
  if (challengeError || !challenge) return { ok: false, error: mfaErrorMessage(challengeError, "Could not check the code. Try again in a moment.") };
  const { error } = await supabase.auth.mfa.verify({ factorId: id.data, challengeId: challenge.id, code: clean });
  if (error) return { ok: false, error: mfaErrorMessage(error, "Could not check the code. Try again in a moment.") };
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Abandons an enrolment that has not been confirmed. A factor that is switched on is removed with removeFactor. */
export async function cancelEnrolment(factorId: string): Promise<ActionResult> {
  await requireContext();
  const id = idSchema.safeParse(factorId);
  if (!id.success) return { ok: false, error: id.error.issues[0].message };
  const supabase = await getServerSupabase();
  const listed = await supabase.auth.mfa.listFactors();
  const factor = listed.data?.all.find((f) => f.id === id.data);
  if (!factor || factor.status !== "unverified") return { ok: false, error: "That authenticator is already switched on, or no longer exists." };
  const { error } = await supabase.auth.mfa.unenroll({ factorId: id.data });
  if (error) return { ok: false, error: mfaErrorMessage(error, "Could not cancel the setup. Try again in a moment.") };
  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Removes an authenticator. Supabase Auth asks for a session that already passed the challenge (aal2) before it removes
 * one that is switched on, so a stolen password alone cannot switch the second step off.
 */
export async function removeFactor(factorId: string): Promise<ActionResult> {
  await requireContext();
  const id = idSchema.safeParse(factorId);
  if (!id.success) return { ok: false, error: id.error.issues[0].message };
  const supabase = await getServerSupabase();
  const { error } = await supabase.auth.mfa.unenroll({ factorId: id.data });
  if (error) {
    log.warn("mfa unenrol failed", { code: error.code ?? "none" });
    return { ok: false, error: mfaErrorMessage(error, "Could not remove the authenticator. Try again in a moment.") };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}
