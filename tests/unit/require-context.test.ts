import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  tables: {} as Record<string, { data: unknown; error: unknown }>,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

// Every query builder method returns the builder; the terminal calls resolve with the table's canned result.
function builder(table: string) {
  const b: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, prop) => (prop === "maybeSingle" || prop === "single" ? () => Promise.resolve(h.tables[table]) : () => b),
    },
  );
  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  getServerSupabase: async () => ({ auth: { getUser: h.getUser }, rpc: h.rpc, from: (table: string) => builder(table) }),
}));

const { requireContext } = await import("@/lib/data/context");

const org = { id: "org-1", name: "Acme (Pty) Ltd", slug: "acme" };

beforeEach(() => {
  h.getUser.mockReset().mockResolvedValue({ data: { user: { id: "u1", email: "thandi@example.test" } } });
  h.rpc.mockReset().mockResolvedValue({ data: [], error: null });
  h.tables = {
    organisation_members: { data: { role: "owner", organisations: org }, error: null },
    profiles: { data: { full_name: "Thandi" }, error: null },
    system_settings: { data: { organisation_id: "org-1" }, error: null },
  };
});

describe("requireContext", () => {
  it("returns the signed-in user's organisation and role", async () => {
    const ctx = await requireContext();
    expect(ctx).toMatchObject({ userId: "u1", organisation: org, role: "owner", fullName: "Thandi" });
  });

  it("sends a signed-out visitor to sign-in", async () => {
    h.getUser.mockResolvedValue({ data: { user: null } });
    await expect(requireContext()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("sends a user who has not accepted the current terms to the acceptance page before anything else", async () => {
    h.rpc.mockResolvedValue({ data: [{ kind: "terms", version: "v2" }], error: null });
    await expect(requireContext()).rejects.toThrow("NEXT_REDIRECT:/legal/accept");
  });

  it("does not wave anyone through when the consent check itself fails", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(requireContext()).rejects.toThrow(/legal/i);
  });

  it("sends a user with no organisation to onboarding", async () => {
    h.tables.organisation_members = { data: null, error: null };
    await expect(requireContext()).rejects.toThrow("NEXT_REDIRECT:/onboarding");
  });
});
