"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createOrganisation, type FormState } from "./actions";

export function OnboardingForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createOrganisation, {});
  return (
    <form action={action} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="name">Company name</Label>
        <Input id="name" name="name" required minLength={2} maxLength={120} autoComplete="organization" />
      </div>
      {state.error && (
        <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Setting up…" : "Create organisation"}
      </Button>
    </form>
  );
}
