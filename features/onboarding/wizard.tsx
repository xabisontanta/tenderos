"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Feedback, TextField } from "@/features/auth/form-parts";
import type { FormState } from "@/features/auth/form-state";
import { MAX_KEYWORDS, MAX_SECTORS } from "@/features/company/schema";
import { SECTOR_SUGGESTIONS } from "@/features/company/sectors";
import { TagInput } from "@/features/company/tag-input";
import { WATCHABLE_PROVINCES } from "@/features/discovery/provinces";
import { saveOnboardingProfile, skipOnboarding } from "./actions";

export interface WizardInitial {
  sectors: string[];
  provinces: string[];
  cidb_grade: string;
  keywords: string[];
}

const STEPS = [
  { field: "sectors", title: "What do you supply?" },
  { field: "provinces", title: "Where can you deliver?" },
  { field: "cidb_grade", title: "Your CIDB grade" },
  { field: "keywords", title: "Keywords" },
] as const;

const list = (value: string | undefined) =>
  value
    ? value
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

/**
 * Four optional questions that tell the Tender Scout which tenders to look for. One form: the
 * steps only show and hide parts of it, so nothing typed on an earlier step is lost and a
 * single submit saves everything. "Skip for now" skips the lot and leaves a working account.
 */
export function OnboardingWizard({ initial }: { initial: WizardInitial }) {
  const [state, action, saving] = useActionState<FormState, FormData>(saveOnboardingProfile, {});
  const [skipState, skip, skipping] = useActionState<FormState, FormData>(skipOnboarding, {});
  const [step, setStep] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const moved = useRef(false);
  const busy = saving || skipping;
  const errors = state.fieldErrors ?? {};
  const values = state.values;
  const watched = new Set(values ? list(values.provinces) : initial.provinces);

  // A problem on a step other than the one showing: go to it.
  useEffect(() => {
    const first = STEPS.findIndex((s) => errors[s.field]);
    if (first !== -1) setStep(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to a new result only
  }, [state]);

  // Moving between steps puts focus on the new heading; a problem puts it on the field.
  useEffect(() => {
    const invalid = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (invalid && !invalid.closest("[hidden]")) invalid.focus();
    else if (moved.current) heading.current?.focus();
  }, [step, state]);

  function go(to: number) {
    moved.current = true;
    setStep(to);
  }

  const last = step === STEPS.length - 1;

  return (
    <form ref={form} action={action} className="grid gap-5" noValidate>
      <div>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Step {step + 1} of {STEPS.length}
        </p>
        <h2 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">
          {STEPS[step].title}
        </h2>
        <div className="mt-2 flex gap-1" aria-hidden>
          {STEPS.map((s, i) => (
            <span key={s.field} className={`h-1 flex-1 rounded-full ${i <= step ? "bg-primary" : "bg-muted"}`} />
          ))}
        </div>
      </div>

      <fieldset hidden={step !== 0} className="grid gap-3">
        <legend className="sr-only">Sectors</legend>
        <TagInput
          id="sectors"
          label="Sectors you work in"
          hint="Press Enter after each one. Matching compares these with the category on the tender, so use the wording you see on eTenders."
          error={errors.sectors}
          defaultValue={values ? list(values.sectors) : initial.sectors}
          suggestions={SECTOR_SUGGESTIONS}
          maxLength={120}
          max={MAX_SECTORS}
          disabled={busy}
        />
      </fieldset>

      <fieldset hidden={step !== 1} className="grid gap-3">
        <legend className="text-xs font-medium text-muted-foreground">Provinces you can deliver in</legend>
        <p className="text-[11px] text-muted-foreground">
          The Tender Scout checks these every morning. National means national departments and entities. Bids are never started automatically unless you switch
          that on later.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-describedby={errors.provinces ? "provinces-error" : undefined}>
          {WATCHABLE_PROVINCES.map((p) => (
            <label key={p.value} className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <input type="checkbox" name="provinces" value={p.value} defaultChecked={watched.has(p.value)} disabled={busy} className="accent-emerald-500" />
              {p.label}
            </label>
          ))}
        </div>
        {errors.provinces && (
          <p id="provinces-error" role="alert" className="text-[11px] text-red-300">
            {errors.provinces}
          </p>
        )}
      </fieldset>

      <fieldset hidden={step !== 2} className="grid gap-3">
        <legend className="sr-only">CIDB grade</legend>
        <TextField
          id="cidb_grade"
          label="CIDB grade"
          maxLength={4}
          autoCapitalize="characters"
          autoComplete="off"
          defaultValue={values ? values.cidb_grade : initial.cidb_grade}
          error={errors.cidb_grade}
          hint="As printed on your CIDB registration: a number from 1 to 9 followed by the class of works, for example 5CE. Leave it empty if you are not registered with the CIDB."
          disabled={busy}
        />
      </fieldset>

      <fieldset hidden={step !== 3} className="grid gap-3">
        <legend className="sr-only">Keywords</legend>
        <TagInput
          id="keywords"
          label="Keywords"
          hint="Words or short phrases that describe the work you want, for example road maintenance or stormwater."
          error={errors.keywords}
          defaultValue={values ? list(values.keywords) : initial.keywords}
          maxLength={60}
          max={MAX_KEYWORDS}
          disabled={busy}
        />
      </fieldset>

      <Feedback state={state.error ? state : skipState} />

      <div className="flex flex-wrap items-center gap-2">
        {step > 0 && (
          <Button type="button" variant="ghost" onClick={() => go(step - 1)} disabled={busy}>
            Back
          </Button>
        )}
        {!last && (
          <Button type="button" variant="outline" onClick={() => go(step + 1)} disabled={busy}>
            Next
          </Button>
        )}
        <Button type="submit" disabled={busy}>
          {saving ? "Saving…" : "Save and finish"}
        </Button>
        <Button type="submit" variant="link" formAction={skip} disabled={busy} className="ml-auto">
          {skipping ? "Skipping…" : "Skip for now"}
        </Button>
      </div>
    </form>
  );
}
