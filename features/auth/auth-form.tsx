"use client";

import Link from "next/link";
import { useActionState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { signIn, signUp } from "./actions";
import type { FormState } from "./form-state";
import { Feedback, TextField, useFocusFirstError } from "./form-parts";
import { TurnstileField } from "./turnstile";

export interface CaptchaConfig {
  mode: "app" | "supabase";
  siteKey: string;
}

export function AuthForm({ mode, next, captcha }: { mode: "login" | "signup"; next?: string; captcha?: CaptchaConfig | null }) {
  const [state, action, pending] = useActionState<FormState, FormData>(mode === "login" ? signIn : signUp, {});
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, state);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? {};

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
      {next && <input type="hidden" name="next" value={next} />}
      {captcha && <TurnstileField siteKey={captcha.siteKey} resetKey={state} />}
      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
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
