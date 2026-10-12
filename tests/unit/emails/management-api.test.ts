import { describe, expect, it } from "vitest";
import { AUTH_TEMPLATES } from "@/emails";
import { resolveBrand } from "@/emails/brand";
import { buildAuthTemplates, managementApiPayload } from "@/emails/build";

const built = buildAuthTemplates(resolveBrand({}));

/**
 * The body PATCHed to https://api.supabase.com/v1/projects/{ref}/config/auth to apply the
 * templates on a hosted project. Field names follow
 * https://supabase.com/docs/guides/auth/auth-email-templates ("Editing email templates").
 */
describe("Management API payload for a hosted project", () => {
  const payload = managementApiPayload(built);

  it("uses the field names from the Supabase Management API docs", () => {
    expect(payload.mailer_subjects_confirmation).toBe("Confirm your email to open TenderOS");
    expect(payload.mailer_templates_confirmation_content).toBe(built.find((b) => b.key === "confirmation")!.html);
    expect(payload.mailer_subjects_magic_link).toBe("Your TenderOS sign-in link");
    expect(payload.mailer_templates_recovery_content).toContain("{{ .TokenHash }}");
    expect(payload.mailer_subjects_password_changed_notification).toBe("Your TenderOS password was changed");
    expect(payload.mailer_templates_mfa_factor_enrolled_notification_content).toContain("{{ .FactorType }}");
    expect(payload.mailer_notifications_identity_unlinked_enabled).toBe(true);
  });

  it("carries one subject and one body per email, and one switch per notification", () => {
    const keys = Object.keys(payload);
    expect(keys.filter((k) => k.startsWith("mailer_subjects_"))).toHaveLength(AUTH_TEMPLATES.length);
    expect(keys.filter((k) => k.startsWith("mailer_templates_"))).toHaveLength(AUTH_TEMPLATES.length);
    expect(keys.filter((k) => k.startsWith("mailer_notifications_"))).toHaveLength(AUTH_TEMPLATES.filter((s) => s.kind === "notification").length);
  });

  it("contains nothing but email fields, so it cannot overwrite SMTP, rate limits or other auth settings", () => {
    for (const key of Object.keys(payload)) expect(key).toMatch(/^mailer_(subjects|templates|notifications)_/);
  });
});
