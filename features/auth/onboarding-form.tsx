"use client";

import { useActionState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { createOrganisation } from "./actions";
import type { FormState } from "./form-state";
import { Feedback, TextField, useFocusFirstError } from "./form-parts";

export function OnboardingForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createOrganisation, {});
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, state);
  return (
    <form ref={form} action={action} className="grid gap-4" noValidate>
      <TextField
        id="name"
        label="Company name"
        required
        maxLength={120}
        autoComplete="organization"
        defaultValue={state.values?.name}
        error={state.fieldErrors?.name}
      />
      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Setting up…" : "Create organisation"}
      </Button>
    </form>
  );
}
