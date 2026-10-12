import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAiEnabled, resolveWebResearchEnabled } from "@/agents/runtime/ai/config";
import { describeAiDeployment } from "@/agents/runtime/ai/deployment";
import { AI_BUDGET_MAX_USD, parseAiSettingsInput, parseDailyBudget } from "@/features/settings/ai-schema";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  role: "owner" as string,
  rpc: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/context", () => ({
  requireContext: async () => ({
    userId: "user-1",
    email: "owner@acme.test",
    organisation: { id: "org-1", name: "Acme", slug: "acme" },
    role: h.role,
  }),
  canAdminister: (role: string) => role === "owner" || role === "admin",
}));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: async () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/supabase/admin", () => ({ getAdminSupabase: () => ({}) }));
vi.mock("@/lib/auth/require-aal2", () => ({ requireAal2: async () => null }));
vi.mock("@/lib/privacy/erasure", () => ({ exportOrganisationData: async () => ({}) }));

const { setAiBudget, setAiSettings } = await import("@/features/settings/actions");

const FULL_ENV = {
  AI_ENABLED: "true",
  ANTHROPIC_API_KEY: "test-key-not-real",
  AI_MODEL_LOW: "model-low",
  AI_MODEL_MID: "model-mid",
  AI_MODEL_HIGH: "model-high",
  AI_PRICE_LOW: "0.1/0.5",
  AI_PRICE_MID: "2/10",
  AI_PRICE_HIGH: "4/20",
};

describe("resolveAiEnabled: the deployment flag is a kill switch ANDed with the organisation's setting", () => {
  it("is off unless both are on", () => {
    expect(resolveAiEnabled(null, {})).toBe(false);
    expect(resolveAiEnabled({}, {})).toBe(false);
    expect(resolveAiEnabled({ ai_enabled: true }, { AI_ENABLED: "true" })).toBe(true);
    expect(resolveAiEnabled({ ai_enabled: true }, { AI_ENABLED: "TRUE" })).toBe(true);
  });

  it("is off when the organisation has not switched it on, whatever the deployment says", () => {
    expect(resolveAiEnabled({ ai_enabled: false }, { AI_ENABLED: "true" })).toBe(false);
    expect(resolveAiEnabled({}, { AI_ENABLED: "true" })).toBe(false);
  });

  it("is off when the deployment has not allowed it, whatever the organisation says", () => {
    expect(resolveAiEnabled({ ai_enabled: true }, {})).toBe(false);
    expect(resolveAiEnabled({ ai_enabled: true }, { AI_ENABLED: "false" })).toBe(false);
    expect(resolveAiEnabled({ ai_enabled: true }, { AI_ENABLED: "1" })).toBe(false);
  });

  it("ignores a column value that is not a boolean", () => {
    expect(resolveAiEnabled({ ai_enabled: "yes" }, { AI_ENABLED: "true" })).toBe(false);
  });
});

describe("resolveWebResearchEnabled", () => {
  it("needs AI on, the organisation's web research setting, and no deployment veto", () => {
    expect(resolveWebResearchEnabled({ ai_enabled: true, ai_web_research_enabled: true }, { AI_ENABLED: "true" })).toBe(true);
    expect(resolveWebResearchEnabled({ ai_enabled: true, ai_web_research_enabled: false }, { AI_ENABLED: "true" })).toBe(false);
    expect(resolveWebResearchEnabled({ ai_enabled: false, ai_web_research_enabled: true }, { AI_ENABLED: "true" })).toBe(false);
    expect(resolveWebResearchEnabled({ ai_enabled: true, ai_web_research_enabled: true }, {})).toBe(false);
    expect(resolveWebResearchEnabled({ ai_enabled: true, ai_web_research_enabled: true }, { AI_ENABLED: "true", AI_WEB_RESEARCH_ENABLED: "false" })).toBe(
      false,
    );
  });
});

describe("describeAiDeployment: says what is missing instead of failing later", () => {
  it("has no problems for a complete configuration", () => {
    expect(describeAiDeployment(FULL_ENV)).toEqual({ allowed: true, problems: [] });
  });

  it("names the deployment switch, the key, and each model and price the AI agents need", () => {
    const res = describeAiDeployment({});
    expect(res.allowed).toBe(false);
    const text = res.problems.join("\n");
    expect(text).toContain("AI_ENABLED");
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).toContain("AI_MODEL_MID");
    expect(text).toContain("AI_PRICE_MID");
    expect(text).toContain("AI_MODEL_HIGH");
    expect(text).toContain("AI_PRICE_HIGH");
  });

  it("does not ask for a tier no AI agent uses", () => {
    const res = describeAiDeployment({ ...FULL_ENV, AI_MODEL_LOW: undefined, AI_PRICE_LOW: undefined });
    expect(res.problems).toEqual([]);
  });

  it("reports a malformed value", () => {
    const res = describeAiDeployment({ ...FULL_ENV, AI_PRICE_MID: "cheap" });
    expect(res.problems.join("\n")).toContain("AI_PRICE_MID");
  });

  it("never echoes the key", () => {
    expect(JSON.stringify(describeAiDeployment({ ...FULL_ENV, AI_PRICE_MID: "oops" }))).not.toContain("test-key-not-real");
  });
});

describe("parseAiSettingsInput", () => {
  it("switching on needs the consent box", () => {
    expect(parseAiSettingsInput({ enabled: true, webResearch: false, consent: false })).toEqual({
      ok: false,
      error: "Tick the box to confirm you have read what is sent to Anthropic",
    });
    expect(parseAiSettingsInput({ enabled: true, webResearch: false, consent: true })).toEqual({ ok: true, enabled: true, webResearch: false });
  });

  it("switching off never needs consent", () => {
    expect(parseAiSettingsInput({ enabled: false, webResearch: false, consent: false })).toEqual({ ok: true, enabled: false, webResearch: false });
  });

  it("web research needs AI to be on", () => {
    expect(parseAiSettingsInput({ enabled: false, webResearch: true, consent: true })).toMatchObject({ ok: false });
  });

  it("only real booleans count", () => {
    for (const bad of [{ enabled: "true", webResearch: false, consent: true }, { enabled: true, webResearch: null, consent: true }, null, "x", {}]) {
      expect(parseAiSettingsInput(bad)).toMatchObject({ ok: false });
    }
  });
});

describe("parseDailyBudget", () => {
  it("accepts a positive amount up to the cap, in dollars and cents", () => {
    expect(parseDailyBudget(5)).toEqual({ ok: true, usd: 5 });
    expect(parseDailyBudget("12.5")).toEqual({ ok: true, usd: 12.5 });
    expect(parseDailyBudget(0.01)).toEqual({ ok: true, usd: 0.01 });
    expect(parseDailyBudget(AI_BUDGET_MAX_USD)).toEqual({ ok: true, usd: AI_BUDGET_MAX_USD });
  });

  it.each([0, -1, AI_BUDGET_MAX_USD + 0.01, Number.NaN, Number.POSITIVE_INFINITY, "", "abc", null, undefined, 1.234, "1e3"])("refuses %s", (bad) => {
    expect(parseDailyBudget(bad)).toMatchObject({ ok: false });
  });
});

describe("setAiSettings", () => {
  beforeEach(() => {
    h.role = "owner";
    h.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  });

  it("calls the database function with the organisation, the choice and the web research flag", async () => {
    const res = await setAiSettings({ enabled: true, webResearch: false, consent: true });
    expect(res).toEqual({ ok: true });
    expect(h.rpc).toHaveBeenCalledWith("set_ai_settings", { p_org: "org-1", p_enabled: true, p_web_research: false });
  });

  it("does not reach the database without the consent box when switching on", async () => {
    const res = await setAiSettings({ enabled: true, webResearch: false, consent: false });
    expect(res).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each(["operator", "viewer"])("is for owners and admins, not a %s", async (role) => {
    h.role = role;
    expect(await setAiSettings({ enabled: false, webResearch: false, consent: false })).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("shows the database's own message for a rule it enforces", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "23514", message: "Set a daily AI budget above zero before switching AI on" } });
    expect(await setAiSettings({ enabled: true, webResearch: false, consent: true })).toEqual({
      ok: false,
      error: "Set a daily AI budget above zero before switching AI on",
    });
  });

  it("tells the person to verify with their authenticator when the database asks for aal2", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "P0403", message: "Verify with your authenticator to do this." } });
    const res = await setAiSettings({ enabled: false, webResearch: false, consent: false });
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/authenticator/i);
  });

  it("does not leak internals for an unexpected failure", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: 'relation "secret_table" does not exist' } });
    const res = await setAiSettings({ enabled: false, webResearch: false, consent: false });
    expect(res).toEqual({ ok: false, error: "Could not change AI assistance" });
  });
});

describe("setAiBudget", () => {
  beforeEach(() => {
    h.role = "admin";
    h.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  });

  it("passes a valid amount to the database function", async () => {
    expect(await setAiBudget(7.5)).toEqual({ ok: true });
    expect(h.rpc).toHaveBeenCalledWith("set_ai_budget", { p_org: "org-1", p_daily_usd: 7.5 });
  });

  it("refuses an invalid amount before the database", async () => {
    expect(await setAiBudget(0)).toMatchObject({ ok: false });
    expect(await setAiBudget(AI_BUDGET_MAX_USD + 1)).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("is for owners and admins", async () => {
    h.role = "operator";
    expect(await setAiBudget(5)).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
