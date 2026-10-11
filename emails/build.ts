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
