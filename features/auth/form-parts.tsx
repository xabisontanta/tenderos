"use client";

import { useEffect, type RefObject } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FormState } from "./form-state";

/**
 * Labelled input wired for assistive technology: the error and hint are tied
 * to the input with aria-describedby, and aria-invalid is set only while there
 * is an error. `defaultValue` should come from the action's returned `values`.
 */
export function TextField({
  id,
  label,
  error,
  hint,
  aside,
  ...input
}: Omit<React.ComponentProps<typeof Input>, "id" | "aria-invalid" | "aria-describedby"> & {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  /** Extra content on the label row, such as a "Forgot password?" link. */
  aside?: React.ReactNode;
}) {
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        {aside}
      </div>
      <Input id={id} name={id} aria-required={input.required || undefined} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
      {hint && (
        <p id={`${id}-hint`} className="text-[11px] text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-[11px] text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A checkbox with its label (which may hold links) and its error tied together for
 * assistive technology. Named like the id, so it posts `on` when ticked.
 */
export function CheckboxField({ id, error, defaultChecked, children }: { id: string; error?: string; defaultChecked?: boolean; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-start gap-2">
        <input
          id={id}
          name={id}
          type="checkbox"
          defaultChecked={defaultChecked}
          aria-required="true"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="mt-0.5 size-4 shrink-0 cursor-pointer accent-emerald-500"
        />
        <Label htmlFor={id} className="cursor-pointer text-xs leading-relaxed font-normal">
          {children}
        </Label>
      </div>
      {error && (
        <p id={`${id}-error`} className="text-[11px] text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

/** The form-level error and success messages. The error takes focus when it appears. */
export function Feedback({ state }: { state: FormState }) {
  return (
    <>
      {state.error && (
        <p
          role="alert"
          tabIndex={-1}
          data-form-error
          className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
        >
          {state.error}
        </p>
      )}
      {state.message && (
        <p role="status" className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          {state.message}
        </p>
      )}
    </>
  );
}

/**
 * After a submit that returned problems, moves focus to the first invalid
 * field, or to the form-level error when no field is at fault, so keyboard
 * and screen-reader users land where the problem is.
 */
export function useFocusFirstError(form: RefObject<HTMLFormElement | null>, state: FormState) {
  useEffect(() => {
    const el = form.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-form-error]');
    el?.focus();
  }, [form, state]);
}
