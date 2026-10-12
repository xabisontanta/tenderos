"use client";

import Link from "next/link";
import { useActionState, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { resendConfirmation, signIn, signUp } from "./actions";
import type { FormState } from "./form-state";
import { CheckboxField, Feedback, TextField, useFocusFirstError } from "./form-parts";
import { TurnstileField } from "./turnstile";
import { LEGAL_PATHS } from "@/lib/legal/versions";

export interface CaptchaConfig {
  mode: "app" | "supabase";
  siteKey: string;
}

export function AuthForm({ mode, next, captcha }: { mode: "login" | "signup"; next?: string; captcha?: CaptchaConfig | null }) {
  const [state, action, pending] = useActionState<FormState, FormData>(mode === "login" ? signIn : signUp, {});
  const [resent, resend, resending] = useActionState<FormState, FormData>(resendConfirmation, {});
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, state);
  useFocusFirstError(form, resent);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? {};
  // A CAPTCHA token works once, so the widget needs a new one after either action.
  const submissions = useMemo(() => [state, resent], [state, resent]);
  const offerResend = state.code === "email_not_confirmed" || state.code === "confirmation_sent";

  return (
    <form ref={form} action={action} className="grid gap-4" noValidate>
      {mode === "signup" && <TextField id="fullName" label="Full name" autoComplete="name" required defaultValue={values.fullName} error={errors.fullName} />}
      <TextField id="email" label="Email" type="email" autoComplete="email" required defaultValue={values.email} error={errors.email} />
      <TextField
        id="password"
        label="Password"
        type="password"
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        required
        error={errors.password}
        hint={mode === "signup" ? "At least 12 characters, with a letter and a number." : undefined}
        aside={
          mode === "login" ? (
            <Link className="text-[11px] text-primary hover:underline" href="/forgot-password">
              Forgot password?
            </Link>
          ) : undefined
        }
      />
      {mode === "signup" && (
        <CheckboxField id="acceptTerms" error={errors.acceptTerms} defaultChecked={values.acceptTerms === "on"}>
          I agree to the{" "}
          <Link className="text-primary underline-offset-2 hover:underline" href={LEGAL_PATHS.terms} target="_blank" rel="noopener">
            Terms of Service
          </Link>{" "}
          and have read the{" "}
          <Link className="text-primary underline-offset-2 hover:underline" href={LEGAL_PATHS.privacy} target="_blank" rel="noopener">
            Privacy Notice
          </Link>
          .
        </CheckboxField>
      )}
      {next && <input type="hidden" name="next" value={next} />}
      {captcha && <TurnstileField siteKey={captcha.siteKey} resetKey={submissions} />}
      <Feedback state={state} />
      {offerResend && (
        <div className="grid gap-2">
          <Button type="submit" variant="outline" size="sm" formAction={resend} disabled={pending || resending}>
            {resending ? "Sending…" : "Send the confirmation email again"}
          </Button>
          <Feedback state={resent} />
        </div>
      )}
      <Button type="submit" disabled={pending || resending}>
        {pending ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        {mode === "login" ? (
          <>
            No account?{" "}
            <Link className="text-primary hover:underline" href="/signup">
              Create one
            </Link>
          </>
        ) : (
          <>
            Already registered?{" "}
            <Link className="text-primary hover:underline" href="/login">
              Sign in
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
