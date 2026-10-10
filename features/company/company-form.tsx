"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WATCHABLE_PROVINCES } from "@/features/discovery/provinces";
import type { Database } from "@/types/database";
import { saveCompanyProfile, type CompanyFormState } from "./actions";

type Profile = Database["public"]["Tables"]["company_profiles"]["Row"];

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

export function CompanyForm({ profile, canEdit }: { profile: Profile | null; canEdit: boolean }) {
  const [state, action, pending] = useActionState<CompanyFormState, FormData>(saveCompanyProfile, {});
  const e = state.fieldErrors ?? {};
  useEffect(() => {
    if (state.ok) toast.success("Company profile saved. Any tender stopped at compliance is being re-checked.");
    if (state.error) toast.error(state.error);
  }, [state]);
  const inv = (k: string) => (e[k] ? { "aria-invalid": true, "aria-describedby": `${k}-error` } : {});
  const p = profile;

  return (
    <form action={action} className="grid gap-6" noValidate>
      <fieldset disabled={!canEdit || pending} className="grid gap-4 rounded-xl border bg-card p-4">
        <legend className="px-1 text-sm font-semibold">Registration and compliance</legend>
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="legal_name" label="Registered company name" error={e.legal_name}>
            <Input id="legal_name" name="legal_name" defaultValue={p?.legal_name ?? ""} maxLength={200} {...inv("legal_name")} />
          </Field>
          <Field id="registration_number" label="CIPC registration number" error={e.registration_number} hint="e.g. 2015/123456/07">
            <Input
              id="registration_number"
              name="registration_number"
              defaultValue={p?.registration_number ?? ""}
              maxLength={40}
              {...inv("registration_number")}
            />
          </Field>
          <Field id="csd_number" label="CSD supplier number" error={e.csd_number} hint="From the Central Supplier Database, starts with MAAA">
            <Input id="csd_number" name="csd_number" defaultValue={p?.csd_number ?? ""} maxLength={11} {...inv("csd_number")} />
          </Field>
          <Field id="authorised_signatory" label="Authorised signatory" error={e.authorised_signatory} hint="The person who signs bid declarations">
            <Input
              id="authorised_signatory"
              name="authorised_signatory"
              defaultValue={p?.authorised_signatory ?? ""}
              maxLength={120}
              {...inv("authorised_signatory")}
            />
          </Field>
          <Field id="tax_pin" label="SARS tax compliance PIN" error={e.tax_pin}>
            <Input id="tax_pin" name="tax_pin" defaultValue={p?.tax_pin ?? ""} maxLength={40} autoComplete="off" {...inv("tax_pin")} />
          </Field>
          <Field id="tax_pin_expires_at" label="Tax PIN valid until" error={e.tax_pin_expires_at}>
            <Input id="tax_pin_expires_at" name="tax_pin_expires_at" type="date" defaultValue={p?.tax_pin_expires_at ?? ""} {...inv("tax_pin_expires_at")} />
          </Field>
          <Field id="bbbee_level" label="B-BBEE level (1 to 8)" error={e.bbbee_level}>
            <Input id="bbbee_level" name="bbbee_level" type="number" min={1} max={8} defaultValue={p?.bbbee_level ?? ""} {...inv("bbbee_level")} />
          </Field>
          <Field id="bbbee_expires_at" label="B-BBEE certificate valid until" error={e.bbbee_expires_at}>
            <Input id="bbbee_expires_at" name="bbbee_expires_at" type="date" defaultValue={p?.bbbee_expires_at ?? ""} {...inv("bbbee_expires_at")} />
          </Field>
          <Field id="cidb_grade" label="CIDB grade (construction only)" error={e.cidb_grade} hint="e.g. 5CE">
            <Input id="cidb_grade" name="cidb_grade" defaultValue={p?.cidb_grade ?? ""} maxLength={4} {...inv("cidb_grade")} />
          </Field>
        </div>
      </fieldset>
      <fieldset disabled={!canEdit || pending} className="grid gap-4 rounded-xl border bg-card p-4">
        <legend className="px-1 text-sm font-semibold">What you can deliver</legend>
        <Field
          id="sectors"
          label="Sectors you work in"
          error={e.sectors}
          hint="Comma separated, using eTenders category names, e.g. Services: Professional, Civil engineering"
        >
          <Input id="sectors" name="sectors" defaultValue={(p?.sectors ?? []).join(", ")} {...inv("sectors")} />
        </Field>
        <Field id="max_contract_value_zar" label="Largest contract you can take on (R)" error={e.max_contract_value_zar}>
          <Input
            id="max_contract_value_zar"
            name="max_contract_value_zar"
            inputMode="numeric"
            defaultValue={p?.max_contract_value_zar ?? ""}
            {...inv("max_contract_value_zar")}
          />
        </Field>
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">Provinces you can deliver in</span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {WATCHABLE_PROVINCES.map((pr) => (
              <label key={pr.value} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <input type="checkbox" name="provinces" value={pr.value} defaultChecked={p?.provinces.includes(pr.value)} className="accent-emerald-500" />
                {pr.label}
              </label>
            ))}
          </div>
        </div>
      </fieldset>
      {canEdit && (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save company profile"}
          </Button>
        </div>
      )}
    </form>
  );
}
