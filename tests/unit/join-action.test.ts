import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const TOKEN = `tinv_${"12ab".repeat(16)}`;

const h = vi.hoisted(() => ({
  token: null as string | null,
  user: { id: "u1" } as { id: string } | null,
  rpc: vi.fn(),
  clear: vi.fn(),
  revalidate: vi.fn(),
  calls: [] as string[],
}));

vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/team/invite-cookie", () => ({ readInviteCookie: async () => h.token, clearInviteCookie: h.clear }));
vi.mock("@/lib/supabase/server", () => ({
  getServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    rpc: async (name: string, args: unknown) => {
      h.calls.push(name);
      return h.rpc(name, args);
    },
  }),
}));

const { acceptInvitation } = await import("@/features/team/join");

beforeEach(() => {
  h.token = TOKEN;
  h.user = { id: "u1" };
  h.calls.length = 0;
  h.clear.mockReset();
  h.revalidate.mockReset();
  h.rpc.mockReset().mockResolvedValue({ data: "org-1", error: null });
});

describe("acceptInvitation", () => {
  it("counts the attempt, accepts with the token from the cookie, forgets the cookie and opens the dashboard", async () => {
    await expect(acceptInvitation({}, new FormData())).rejects.toThrow("NEXT_REDIRECT:/");
    expect(h.calls).toEqual(["hit_rate_limit", "accept_invitation"]);
    expect(h.rpc).toHaveBeenCalledWith("hit_rate_limit", { p_action: "invitation.accept_attempt", p_max: 20, p_window_seconds: 3600 });
    expect(h.rpc).toHaveBeenCalledWith("accept_invitation", { p_token: TOKEN });
    expect(h.clear).toHaveBeenCalled();
    expect(h.revalidate).toHaveBeenCalled();
  });

  it("takes no token from the form, only from the cookie", async () => {
    const fd = new FormData();
    fd.set("token", `tinv_${"ff".repeat(32)}`);
    await expect(acceptInvitation({}, fd)).rejects.toThrow("NEXT_REDIRECT");
    expect(h.rpc).toHaveBeenCalledWith("accept_invitation", { p_token: TOKEN });
  });

  it("asks the person to open the email link again when the cookie is gone", async () => {
    h.token = null;
    const res = await acceptInvitation({}, new FormData());
    expect(res.error).toMatch(/open the link in your invitation email/i);
    expect(h.calls).toEqual([]);
  });

  it("sends someone who is not signed in to sign in, and back to the invitation", async () => {
    h.user = null;
    await expect(acceptInvitation({}, new FormData())).rejects.toThrow("NEXT_REDIRECT:/login?next=%2Finvite");
    expect(h.calls).toEqual([]);
  });

  it("shows the database's explanation and keeps the cookie, so a fixed problem needs no new link", async () => {
    h.rpc.mockImplementation(async (name: string) =>
      name === "accept_invitation"
        ? {
            data: null,
            error: {
              code: "23514",
              message: "You already belong to another organisation. Leave it first (Settings, Team, Leave), then open the invitation link again.",
            },
          }
        : { data: null, error: null },
    );
    const res = await acceptInvitation({}, new FormData());
    expect(res.error).toMatch(/already belong to another organisation/);
    expect(h.clear).not.toHaveBeenCalled();
  });

  it("forgets the cookie when the invitation is dead, so the page stops offering it", async () => {
    h.rpc.mockImplementation(async (name: string) =>
      name === "accept_invitation"
        ? { data: null, error: { code: "23514", message: "This invitation is no longer valid. Ask the person who invited you to send a new one." } }
        : { data: null, error: null },
    );
    const res = await acceptInvitation({}, new FormData());
    expect(res.error).toMatch(/no longer valid/);
    expect(h.clear).toHaveBeenCalled();
  });

  it("stops before the database when the attempt limit is hit", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "P0429", message: "Too many requests; please wait and try again" } });
    const res = await acceptInvitation({}, new FormData());
    expect(res.error).toMatch(/too many requests/i);
    expect(h.calls).toEqual(["hit_rate_limit"]);
  });

  it("hides anything unexpected", async () => {
    h.rpc.mockImplementation(async (name: string) =>
      name === "accept_invitation" ? { data: null, error: { code: "XX000", message: "relation boom" } } : { data: null, error: null },
    );
    expect((await acceptInvitation({}, new FormData())).error).toBe("Could not accept the invitation");
  });
});
