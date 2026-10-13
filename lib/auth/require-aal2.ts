import "server-only";

import { getServerSupabase } from "@/lib/supabase/server";
import type { AppContext } from "@/lib/data/context";
import { AAL2_MESSAGE } from "./mfa-errors";

/**
 * The second-factor check for the paths that run as the service role (or do outside work first) and so skip the database's own
 * `private.require_aal2`: sending a bid by email, registering a document, connecting Gmail, creating a browser pairing, the
 * organisation export. Same rule as the database: when the organisation requires MFA, the session must have passed the
 * authenticator challenge (`aal` is `aal2`). Returns the message to show, or null when the action may go on.
 *
 * When the level cannot be read it refuses: an organisation that asked for a second factor does not get "probably fine".
 */
export async function requireAal2(ctx: { settings?: Pick<AppContext["settings"], "require_mfa"> }): Promise<string | null> {
  if (!ctx.settings?.require_mfa) return null;
  try {
    const supabase = await getServerSupabase();
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return data?.currentLevel === "aal2" ? null : AAL2_MESSAGE;
  } catch {
    return AAL2_MESSAGE;
  }
}
