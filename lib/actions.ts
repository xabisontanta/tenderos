import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { AAL2_MESSAGE } from "@/lib/auth/mfa-errors";

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

/** Maps database errors to messages safe to show users (no internals). */
export function toUserError(error: PostgrestError | Error | null | undefined, fallback = "Something went wrong"): string {
  if (!error) return fallback;
  const code = "code" in error ? error.code : undefined;
  // private.require_aal2: the organisation requires an authenticator and this session has not passed the challenge.
  if (code === "P0403") return AAL2_MESSAGE;
  // Our RPCs raise check_violation / insufficient_privilege / unique_violation / P0429 with user-facing text.
  if (code && ["23514", "42501", "23505", "P0429", "P0001"].includes(code)) return error.message;
  if (code === "23503") return "A referenced record no longer exists";
  return fallback;
}

export async function rateLimit(supabase: SupabaseClient<Database>, action: string, max = 30, windowSeconds = 60): Promise<string | null> {
  const { error } = await supabase.rpc("hit_rate_limit", { p_action: action, p_max: max, p_window_seconds: windowSeconds });
  return error ? toUserError(error, "Too many requests") : null;
}
