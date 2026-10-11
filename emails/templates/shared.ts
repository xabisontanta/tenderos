import type { Block, EmailContent } from "../layout";

/** Supabase substitutes this with auth.site_url (supabase/config.toml, or the dashboard on a hosted project). */
export const SITE = "{{ .SiteURL }}";

/**
 * How long a Supabase email link or code lives. Supabase has no template
 * variable for it, so the copy is fixed here and a unit test compares it with
 * [auth.email] otp_expiry in supabase/config.toml. Change both together.
 */
export const AUTH_LINK_EXPIRY = { seconds: 3600, label: "1 hour" } as const;

export interface AuthEmailSpec {
  /** The key under [auth.email.template.*] or [auth.email.notification.*]. */
  key: string;
  kind: "template" | "notification";
  /** File written to supabase/templates. */
  file: string;
  subject: string;
  /** Go-template variables Supabase provides to this email; a test rejects any other. */
  variables: readonly string[];
  content: () => EmailContent;
}

export function template(key: string, subject: string, variables: readonly string[], content: () => EmailContent): AuthEmailSpec {
  return { key, kind: "template", file: `${key}.html`, subject, variables: [...variables, "SiteURL"], content };
}

export function notification(key: string, subject: string, variables: readonly string[], content: () => EmailContent): AuthEmailSpec {
  return { key, kind: "notification", file: `${key}_notification.html`, subject, variables: [...variables, "SiteURL"], content };
}

/** "This link works once and expires in 1 hour." */
export function expiryNote(what: "link" | "code" = "link"): string {
  return `This ${what} works once and expires in ${AUTH_LINK_EXPIRY.label}.`;
}

/** The "Didn't ask for this?" paragraph that closes every email asking for an action. */
export function safety(title: string, body: string): Block {
  return { type: "safety", title, body };
}

/** Go-template snippets that turn Supabase's machine values into words people use. */
export const FACTOR_LABEL = `{{ if eq .FactorType "totp" }}Authenticator app{{ else if eq .FactorType "phone" }}Phone (text message code){{ else if eq .FactorType "webauthn" }}Security key or passkey{{ else }}{{ .FactorType }}{{ end }}`;

export const PROVIDER_LABEL = `{{ if eq .Provider "google" }}Google{{ else if eq .Provider "github" }}GitHub{{ else if eq .Provider "azure" }}Microsoft{{ else if eq .Provider "apple" }}Apple{{ else if eq .Provider "linkedin_oidc" }}LinkedIn{{ else }}{{ .Provider }}{{ end }}`;
