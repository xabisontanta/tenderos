"use client";

import { useActionState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Feedback, useFocusFirstError } from "@/features/auth/form-parts";
import type { FormState } from "@/features/auth/form-state";
import { acceptInvitation } from "./join";

/** The "Join <organisation>" button on the onboarding page, for someone whose invitation is in their cookie. */
export function JoinInvitation({ organisationName }: { organisationName: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(acceptInvitation, {});
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, state);
  return (
    <form ref={form} action={action} className="grid gap-3" noValidate>
      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Joining…" : `Join ${organisationName}`}
      </Button>
    </form>
  );
}
