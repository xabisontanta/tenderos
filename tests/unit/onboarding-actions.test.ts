import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  role: "owner" as string,
  upsert: vi.fn(),
  rpc: vi.fn(),
  revalidatePath: vi.fn(),
  settings: { onboarding_completed_at: null as string | null },
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/data/context", () => ({
  requireContext: async () => ({ organisation: { id: "org-1" }, role: h.role, settings: h.settings }),
  canAdminister: (role: string) => role === "owner" || role === "admin",
}));
vi.mock("@/lib/supabase/server", () => ({
  getServerSupabase: async () => ({ from: () => ({ upsert: h.upsert }), rpc: h.rpc }),
}));

const { saveOnboardingProfile, skipOnboarding } = await import("@/features/onboarding/actions");

function form(entries: Array<[string, string]>) {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

const filled: Array<[string, string]> = [
  ["sectors", "Construction"],
  ["sectors", "Civil engineering"],
  ["provinces", "GAUTENG"],
  ["provinces", "WESTERN_CAPE"],
  ["cidb_grade", "5ce"],
  ["keywords", "road maintenance"],
  ["keywords", "paving, stormwater"],
];

beforeEach(() => {
  h.role = "owner";
  h.settings = { onboarding_completed_at: null };
  h.upsert.mockReset().mockResolvedValue({ error: null });
  h.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  h.revalidatePath.mockReset();
});

describe("saveOnboardingProfile", () => {
  it("saves the profile, watches the provinces with auto-run off, marks onboarding done and goes to Discover", async () => {
    await expect(saveOnboardingProfile({}, form(filled))).rejects.toThrow("NEXT_REDIRECT:/discover");
    expect(h.upsert).toHaveBeenCalledWith(
      {
        organisation_id: "org-1",
        sectors: ["Construction", "Civil engineering"],
        provinces: ["GAUTENG", "WESTERN_CAPE"],
        cidb_grade: "5CE",
        keywords: ["road maintenance", "paving", "stormwater"],
      },
      { onConflict: "organisation_id" },
    );
    expect(h.rpc).toHaveBeenNthCalledWith(1, "set_watched_provinces", { p_org: "org-1", p_provinces: ["GAUTENG", "WESTERN_CAPE"], p_auto_run: false });
    expect(h.rpc).toHaveBeenNthCalledWith(2, "complete_onboarding", { p_org: "org-1" });
    expect(h.revalidatePath).toHaveBeenCalledWith("/discover");
  });

  it("never turns automatic workflows on", async () => {
    await saveOnboardingProfile({}, form(filled)).catch(() => {});
    const call = h.rpc.mock.calls.find(([name]) => name === "set_watched_provinces");
    expect(call![1].p_auto_run).toBe(false);
  });

  it("saves only what was filled in, so a blank field cannot erase what the company page holds", async () => {
    await saveOnboardingProfile({}, form([["keywords", "paving"]])).catch(() => {});
    expect(h.upsert).toHaveBeenCalledWith({ organisation_id: "org-1", keywords: ["paving"] }, { onConflict: "organisation_id" });
    expect(h.rpc.mock.calls.map(([name]) => name)).toEqual(["complete_onboarding"]);
  });

  it("finishing with nothing filled in is the same as skipping: no profile written, onboarding done", async () => {
    await expect(saveOnboardingProfile({}, form([]))).rejects.toThrow("NEXT_REDIRECT:/discover");
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.rpc.mock.calls.map(([name]) => name)).toEqual(["complete_onboarding"]);
  });

  it("returns what is wrong, per field, and keeps what was typed", async () => {
    const state = await saveOnboardingProfile(
      {},
      form([
        ["sectors", "Construction"],
        ["keywords", "a"],
        ["cidb_grade", "nope"],
        ["provinces", "GAUTENG"],
      ]),
    );
    expect(state.fieldErrors).toHaveProperty("keywords");
    expect(state.fieldErrors).toHaveProperty("cidb_grade");
    expect(state.fieldErrors).not.toHaveProperty("sectors");
    expect(state.values).toEqual({ sectors: "Construction", provinces: "GAUTENG", cidb_grade: "NOPE", keywords: "a" });
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("is for owners and admins only", async () => {
    h.role = "operator";
    const state = await saveOnboardingProfile({}, form(filled));
    expect(state.error).toMatch(/owners and admins/i);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("reports a failed save instead of carrying on", async () => {
    h.upsert.mockResolvedValue({ error: { code: "23514", message: "violates check constraint" } });
    const state = await saveOnboardingProfile({}, form(filled));
    expect(state.error).toBeTruthy();
    expect(state.values?.sectors).toBe("Construction, Civil engineering");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("reports a failed province save and does not mark onboarding done", async () => {
    h.rpc.mockImplementation(async (name: string) =>
      name === "set_watched_provinces" ? { data: null, error: { code: "XX000", message: "boom" } } : { data: null, error: null },
    );
    const state = await saveOnboardingProfile({}, form(filled));
    expect(state.error).toMatch(/provinces/i);
    expect(h.rpc.mock.calls.map(([name]) => name)).toEqual(["set_watched_provinces"]);
  });
});

describe("skipOnboarding", () => {
  it("marks onboarding done and writes nothing else, leaving a working account", async () => {
    await expect(skipOnboarding()).rejects.toThrow("NEXT_REDIRECT:/discover");
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.rpc.mock.calls).toEqual([["complete_onboarding", { p_org: "org-1" }]]);
  });

  it("does not let an operator touch the settings", async () => {
    h.role = "viewer";
    await expect(skipOnboarding()).rejects.toThrow("NEXT_REDIRECT:/");
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
