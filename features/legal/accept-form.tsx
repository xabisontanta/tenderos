"use client";

import Link from "next/link";
import { useActionState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { CheckboxField, Feedback, useFocusFirstError } from "@/features/auth/form-parts";
import type { FormState } from "@/features/auth/form-state";
import { LEGAL_PATHS } from "@/lib/legal/versions";
import { acceptLegalDocuments } from "./actions";

export function AcceptForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(acceptLegalDocuments, {});
  const form = useRef<HTMLFormElement>(null);
  useFocusFirstError(form, state);
  return (
    <form ref={form} action={action} className="grid gap-4" noValidate>
      <CheckboxField id="accept" error={state.fieldErrors?.accept}>
        I accept the{" "}
        <Link className="text-primary underline-offset-2 hover:underline" href={LEGAL_PATHS.terms} target="_blank" rel="noopener">
          Terms of Service
        </Link>{" "}
        and the{" "}
        <Link className="text-primary underline-offset-2 hover:underline" href={LEGAL_PATHS.privacy} target="_blank" rel="noopener">
          Privacy Notice
        </Link>
        .
      </CheckboxField>
      {next !== "/" && <input type="hidden" name="next" value={next} />}
      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Accept and continue"}
      </Button>
    </form>
  );
}
