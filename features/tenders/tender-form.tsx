"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { PROVINCES } from "@/lib/format";
import { createTender, type TenderFormState } from "./actions";

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      {error && (
        <p id={`${id}-error`} className="text-[11px] text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

export function TenderForm() {
  const [state, action, pending] = useActionState<TenderFormState, FormData>(createTender, {});
  const e = state.fieldErrors ?? {};
  const inv = (k: string) => (e[k] ? { "aria-invalid": true, "aria-describedby": `${k}-error` } : {});

  return (
    <form action={action} className="grid gap-6" noValidate>
      <fieldset className="grid gap-4 rounded-xl border bg-card p-4">
        <legend className="px-1 text-sm font-semibold">Tender</legend>
        <Field id="title" label="Title *" error={e.title}>
          <Input id="title" name="title" required maxLength={300} {...inv("title")} />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="issuing_organisation" label="Issuing organisation *" error={e.issuing_organisation}>
            <Input id="issuing_organisation" name="issuing_organisation" required maxLength={200} {...inv("issuing_organisation")} />
          </Field>
          <Field id="reference_number" label="Reference number" error={e.reference_number}>
            <Input id="reference_number" name="reference_number" maxLength={120} {...inv("reference_number")} />
          </Field>
          <Field id="province" label="Province" error={e.province}>
            <NativeSelect id="province" name="province" defaultValue="UNKNOWN">
              {PROVINCES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="sector" label="Sector" error={e.sector}>
            <Input id="sector" name="sector" maxLength={120} />
          </Field>
          <Field id="estimated_value_zar" label="Estimated value (ZAR)" error={e.estimated_value_zar} hint="Leave blank if not published">
            <Input id="estimated_value_zar" name="estimated_value_zar" inputMode="decimal" {...inv("estimated_value_zar")} />
          </Field>
          <Field id="source_url" label="Source URL" error={e.source_url}>
            <Input id="source_url" name="source_url" type="url" placeholder="https://" {...inv("source_url")} />
          </Field>
        </div>
        <Field id="description" label="Scope / description" error={e.description}>
          <Textarea id="description" name="description" maxLength={10000} rows={4} />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 rounded-xl border bg-card p-4">
        <legend className="px-1 text-sm font-semibold">Dates (South African time)</legend>
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="closing_at" label="Closing date and time *" error={e.closing_at}>
            <Input id="closing_at" name="closing_at" type="datetime-local" required {...inv("closing_at")} />
          </Field>
          <Field id="published_at" label="Published" error={e.published_at}>
            <Input id="published_at" name="published_at" type="datetime-local" {...inv("published_at")} />
          </Field>
          <Field id="briefing_at" label="Briefing" error={e.briefing_at}>
            <Input id="briefing_at" name="briefing_at" type="datetime-local" {...inv("briefing_at")} />
          </Field>
          <Field id="questions_deadline_at" label="Questions deadline" error={e.questions_deadline_at}>
            <Input id="questions_deadline_at" name="questions_deadline_at" type="datetime-local" />
          </Field>
          <Field id="briefing_location" label="Briefing location" error={e.briefing_location}>
            <Input id="briefing_location" name="briefing_location" maxLength={300} />
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" name="briefing_compulsory" className="size-4 accent-[var(--primary)]" />
            Briefing is compulsory
          </label>
        </div>
      </fieldset>

      <fieldset className="grid gap-4 rounded-xl border bg-card p-4">
        <legend className="px-1 text-sm font-semibold">Submission</legend>
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="submission_method" label="Method" error={e.submission_method}>
            <NativeSelect id="submission_method" name="submission_method" defaultValue="UNKNOWN">
              <option value="ELECTRONIC_PORTAL">Electronic portal</option>
              <option value="EMAIL">Email</option>
              <option value="PHYSICAL">Physical delivery</option>
              <option value="UNKNOWN">Unknown</option>
            </NativeSelect>
          </Field>
          <Field id="submission_destination" label="Destination" error={e.submission_destination} hint="Portal, address or tender box">
            <Input id="submission_destination" name="submission_destination" maxLength={500} />
          </Field>
        </div>
      </fieldset>

      <label className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
        <input type="checkbox" name="is_simulation" defaultChecked className="mt-0.5 size-4 accent-amber-400" />
        <span>
          <span className="font-medium">Simulation tender</span>
          <span className="block text-[12px] text-muted-foreground">
            The simulated workflow runs every agent step and approval gate without AI calls or external submission. Untick for a real tender you are tracking;
            real tenders cannot run the simulated workflow, so their records are never marked as submitted by a simulation.
          </span>
        </span>
      </label>

      {state.error && (
        <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {state.error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Create tender"}
        </Button>
      </div>
    </form>
  );
}
