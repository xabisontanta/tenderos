/** Largest daily AI budget an organisation can set, in USD. Mirrored by set_ai_budget in the database. */
export const AI_BUDGET_MAX_USD = 1000;

export type AiSettingsInput = { ok: true; enabled: boolean; webResearch: boolean } | { ok: false; error: string };

/**
 * The AI assistance form: switching it on needs the person to have ticked the consent box (what is sent to Anthropic,
 * and that it is processed outside South Africa), and web research only makes sense while AI is on.
 */
export function parseAiSettingsInput(input: unknown): AiSettingsInput {
  const v = input as { enabled?: unknown; webResearch?: unknown; consent?: unknown } | null;
  if (!v || typeof v !== "object" || typeof v.enabled !== "boolean" || typeof v.webResearch !== "boolean" || typeof v.consent !== "boolean") {
    return { ok: false, error: "Choose on or off" };
  }
  if (v.webResearch && !v.enabled) return { ok: false, error: "Web research needs AI assistance to be on" };
  if (v.enabled && !v.consent) return { ok: false, error: "Tick the box to confirm you have read what is sent to Anthropic" };
  return { ok: true, enabled: v.enabled, webResearch: v.webResearch };
}

export type DailyBudgetInput = { ok: true; usd: number } | { ok: false; error: string };

/** A daily budget in dollars and cents: more than zero, no more than the cap. */
export function parseDailyBudget(input: unknown): DailyBudgetInput {
  const n = typeof input === "number" ? input : typeof input === "string" && /^\d{1,6}(\.\d{1,2})?$/.test(input.trim()) ? Number(input.trim()) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "Enter a daily budget above zero, in US dollars" };
  if (Math.round(n * 100) / 100 !== n) return { ok: false, error: "Use dollars and cents, for example 5.00" };
  if (n > AI_BUDGET_MAX_USD) return { ok: false, error: `The daily budget cannot be more than $${AI_BUDGET_MAX_USD}` };
  return { ok: true, usd: n };
}
