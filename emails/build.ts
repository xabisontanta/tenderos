import type { Brand } from "./brand";
import { AUTH_TEMPLATES } from "./index";
import { renderEmail, supabaseContext } from "./layout";

export interface BuiltTemplate {
  key: string;
  kind: "template" | "notification";
  /** File name under supabase/templates. */
  file: string;
  subject: string;
  html: string;
}

/**
 * The JSON body for PATCH https://api.supabase.com/v1/projects/{ref}/config/auth
 * that applies every subject and template to a hosted project (and switches the
 * security notifications on). Only mailer_* fields: it cannot touch SMTP,
 * rate limits or any other auth setting. Nothing is sent from here.
 */
export function managementApiPayload(templates: readonly BuiltTemplate[]): Record<string, string | boolean> {
  const body: Record<string, string | boolean> = {};
  for (const t of templates) {
    const name = t.kind === "notification" ? `${t.key}_notification` : t.key;
    body[`mailer_subjects_${name}`] = t.subject;
    body[`mailer_templates_${name}_content`] = t.html;
    if (t.kind === "notification") body[`mailer_notifications_${t.key}_enabled`] = true;
  }
  return body;
}

/**
 * Renders every Supabase email. Images point at {{ .SiteURL }}/email/*.png
 * unless `assetBase` overrides them (a CDN, or a fixed https origin when a
 * hosted project does not expose SiteURL to a notification template).
 */
export function buildAuthTemplates(brand: Brand, opts: { assetBase?: string } = {}): BuiltTemplate[] {
  const ctx = supabaseContext(brand, opts);
  return AUTH_TEMPLATES.map((spec) => ({
    key: spec.key,
    kind: spec.kind,
    file: spec.file,
    subject: spec.subject,
    html: renderEmail(spec.content(), ctx).html,
  }));
}
