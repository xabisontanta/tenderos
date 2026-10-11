import type { z } from "zod";

/**
 * State returned by every auth server action. `values` carries back what the
 * visitor typed (never a password) so the form can show it again: React resets
 * uncontrolled inputs after an action, which would otherwise wipe the form on
 * every validation error.
 */
export interface FormState {
  /** Problem with the form as a whole (not tied to one field). */
  error?: string;
  message?: string;
  /** First problem per field, keyed by the input's name. */
  fieldErrors?: Record<string, string>;
  values?: Record<string, string>;
  /** Lets the form offer a next step: resending the confirmation email. */
  code?: "email_not_confirmed" | "confirmation_sent";
}

/** First message per field from a zod error. */
export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "");
    if (key && !(key in out)) out[key] = issue.message;
  }
  return out;
}

/** A submitted text field, or "" when it is missing or a file. */
export function textOf(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}
