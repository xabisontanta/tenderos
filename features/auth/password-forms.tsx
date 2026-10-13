"use client";

import Link from "next/link";
import { useActionState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { requestPasswordReset, updatePassword } from "./actions";
import type { CaptchaConfig } from "./auth-form";
import type { FormState } from "./form-state";
import { Feedback, TextField, useFocusFirstError } from "./form-parts";
import { TurnstileField } from "./turnstile";

export function ForgotPasswordForm({ captcha }: { captcha?: CaptchaConfig | null }) {
  const [state, action, pending] = useActionState<FormState, FormData>(requestPasswordReset, {});
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, state);
  return (
    <form ref={form} action={action} className="grid gap-4" noValidate>
      <TextField id="email" label="Email" type="email" autoComplete="email" required defaultValue={state.values?.email} error={state.fieldErrors?.email} />
      {captcha && <TurnstileField siteKey={captcha.siteKey} resetKey={state} />}
      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Please wait…" : "Send reset link"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        <Link className="text-primary hover:underline" href="/login">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

export function ResetPasswordForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(updatePassword, {});
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, state);
  return (
    <form ref={form} action={action} className="grid gap-4" noValidate>
      <TextField
        id="password"
        label="New password"
        type="password"
        autoComplete="new-password"
        required
        error={state.fieldErrors?.password}
        hint="At least 12 characters, with a letter and a number."
      />
      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Please wait…" : "Save new password"}
      </Button>
    </form>
  );
}
