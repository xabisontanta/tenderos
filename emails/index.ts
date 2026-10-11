import { confirmSignup } from "./templates/confirm-signup";
import { emailChange } from "./templates/email-change";
import { emailChanged } from "./templates/email-changed";
import { identityLinked } from "./templates/identity-linked";
import { identityUnlinked } from "./templates/identity-unlinked";
import { invite } from "./templates/invite";
import { magicLink } from "./templates/magic-link";
import { mfaFactorEnrolled } from "./templates/mfa-factor-enrolled";
import { mfaFactorUnenrolled } from "./templates/mfa-factor-unenrolled";
import { passwordChanged } from "./templates/password-changed";
import { phoneChanged } from "./templates/phone-changed";
import { reauthentication } from "./templates/reauthentication";
import { recovery } from "./templates/recovery";
import type { AuthEmailSpec } from "./templates/shared";

export { AUTH_LINK_EXPIRY, type AuthEmailSpec } from "./templates/shared";

/**
 * Every email Supabase Auth sends, in the order the config.toml blocks list
 * them. Source of truth for subjects and files: scripts/build-email-templates.ts
 * writes them to supabase/templates, and a unit test checks config.toml agrees.
 */
export const AUTH_TEMPLATES: readonly AuthEmailSpec[] = [
  confirmSignup,
  invite,
  magicLink,
  recovery,
  emailChange,
  reauthentication,
  passwordChanged,
  emailChanged,
  phoneChanged,
  mfaFactorEnrolled,
  mfaFactorUnenrolled,
  identityLinked,
  identityUnlinked,
];
