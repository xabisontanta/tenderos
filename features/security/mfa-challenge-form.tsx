"use client";

import { useActionState, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Feedback, TextField, useFocusFirstError } from "@/features/auth/form-parts";
import type { FormState } from "@/features/auth/form-state";
import { verifyChallenge } from "./actions";

export interface ChallengeFactor {
  id: string;
  name: string;
}

/** The six-digit check on /mfa. With several authenticators the person picks which one they are reading from. */
export function MfaChallengeForm({ factors, next }: { factors: ChallengeFactor[]; next: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(verifyChallenge, {});
  const form = useRef<HTMLFormElement>(null);
  const pick = useId();
  useFocusFirstError(form, state);
  return (
    <form ref={form} action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="next" value={next} />
      {factors.length === 1 ? (
        <input type="hidden" name="factorId" value={factors[0].id} />
      ) : (
        <div className="grid gap-1.5">
          <Label htmlFor={pick}>Authenticator</Label>
          <NativeSelect id={pick} name="factorId" defaultValue={factors[0]?.id}>
            {factors.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      <TextField
        id="code"
        label="Code from your authenticator app"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        required
        maxLength={8}
        hint="Six digits. The code changes every 30 seconds."
        error={state.fieldErrors?.code}
      />
      <Feedback state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Checking…" : "Verify"}
      </Button>
    </form>
  );
}
