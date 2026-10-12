import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requestHeaders: {} as Record<string, string>,
  getUser: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers(h.requestHeaders) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: async () => ({ auth: { getUser: h.getUser }, rpc: h.rpc }) }));

const { acceptLegalDocuments } = await import("@/features/legal/actions");
const { pendingLegalAcceptances } = await import("@/lib/legal/status");
const { LEGAL_VERSIONS } = await import("@/lib/legal/versions");

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("APP_URL", "https://app.tenderos.example");
  vi.stubEnv("AUTH_RATE_LIMIT_SECRET", "k".repeat(40));
  vi.stubEnv("TRUSTED_IP_HEADER", "x-vercel-forwarded-for");
  h.requestHeaders = { "x-vercel-forwarded-for": "41.0.0.9" };
  h.getUser.mockReset().mockResolvedValue({ data: { user: { id: "u1" } } });
  h.rpc.mockReset().mockResolvedValue({ data: null, error: null });
});

describe("acceptLegalDocuments", () => {
  it("records acceptance of the current versions and goes on to the page asked for", async () => {
    await expect(acceptLegalDocuments({}, form({ accept: "on", next: "/tenders" }))).rejects.toThrow("NEXT_REDIRECT:/tenders");
    expect(h.rpc).toHaveBeenCalledWith("accept_legal", {
      p_terms_version: LEGAL_VERSIONS.terms,
      p_privacy_version: LEGAL_VERSIONS.privacy,
      p_ip_hmac: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(h.rpc.mock.calls)).not.toContain("41.0.0.9");
  });

  it("ignores an unsafe next", async () => {
    await expect(acceptLegalDocuments({}, form({ accept: "on", next: "//evil.example" }))).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("does nothing until the box is ticked", async () => {
    const state = await acceptLegalDocuments({}, form({}));
    expect(state.fieldErrors?.accept).toBeTruthy();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("sends a signed-out visitor to sign-in", async () => {
    h.getUser.mockResolvedValue({ data: { user: null } });
    await expect(acceptLegalDocuments({}, form({ accept: "on" }))).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("explains when the documents changed while the page was open", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "23514", message: "These documents have been updated. Reload the page to read the new versions." } });
    const state = await acceptLegalDocuments({}, form({ accept: "on" }));
    expect(state.error).toMatch(/updated/i);
  });

  it("does not leak other database errors", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "relation legal_acceptances is broken" } });
    const state = await acceptLegalDocuments({}, form({ accept: "on" }));
    expect(state.error).toBe("Could not record your acceptance");
  });
});

describe("pendingLegalAcceptances", () => {
  it("lists the kinds still to accept", async () => {
    h.rpc.mockResolvedValue({ data: [{ kind: "privacy", version: "v2" }], error: null });
    const supabase = { rpc: h.rpc } as never;
    expect(await pendingLegalAcceptances(supabase)).toEqual([{ kind: "privacy", version: "v2" }]);
    expect(h.rpc).toHaveBeenCalledWith("pending_legal_acceptances");
  });

  it("throws rather than waving the visitor through when the check fails", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(pendingLegalAcceptances({ rpc: h.rpc } as never)).rejects.toThrow(/legal/i);
  });
});
