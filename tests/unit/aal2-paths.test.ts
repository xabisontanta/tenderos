import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The paths that run as the service role, or do outside work first, skip the database's own second-factor check. Each calls
 * requireAal2(ctx) after its role check and before anything else, and these tests prove it by making that check refuse and
 * showing that nothing else was reached.
 */
const AAL2 = "Verify with your authenticator to do this.";

const h = vi.hoisted(() => ({
  role: "owner" as string,
  aal2: vi.fn(),
  touched: [] as string[],
}));

const boom = (what: string) => () => {
  h.touched.push(what);
  throw new Error(`${what} must not be reached while the second factor is missing`);
};

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/require-aal2", () => ({ requireAal2: (...args: unknown[]) => h.aal2(...args) }));
vi.mock("@/lib/data/context", () => ({
  requireContext: async () => ({
    userId: "u1",
    email: "owner@acme.test",
    fullName: "Owner",
    organisation: { id: "org-1", name: "Acme", slug: "acme" },
    role: h.role,
    settings: { require_mfa: true },
  }),
  canAdminister: (r: string) => r === "owner" || r === "admin",
  canOperate: (r: string) => r !== "viewer",
}));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: boom("the user's database client") }));
vi.mock("@/lib/supabase/admin", () => ({ getAdminSupabase: boom("the service-role client") }));
vi.mock("@/lib/email/smtp", () => ({ sendWithSmtp: boom("SMTP"), verifySmtp: boom("the SMTP check") }));
vi.mock("@/lib/email/gmail", () => ({
  googleConfig: () => ({ clientId: "id", clientSecret: "secret" }),
  googleAuthUrl: () => "https://accounts.google.com/o/oauth2/v2/auth?x=1",
  exchangeGoogleCode: boom("the Google token exchange"),
  sendWithGmail: boom("Gmail"),
  OAUTH_COOKIE: "tos_google_oauth",
}));
vi.mock("@/lib/privacy/erasure", () => ({ exportOrganisationData: boom("the export") }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ APP_URL: "https://app.tenderos.example" }) }));
vi.mock("@/lib/log", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({}) }),
}));

const email = await import("@/features/email/actions");
const documents = await import("@/features/documents/actions");
const autofill = await import("@/features/autofill/actions");
const settings = await import("@/features/settings/actions");
const googleStart = await import("@/app/api/email/google/start/route");
const googleCallback = await import("@/app/api/email/google/callback/route");

const UUID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  h.role = "owner";
  h.touched.length = 0;
  h.aal2.mockReset().mockResolvedValue(AAL2);
});

describe("with the requirement on and no second factor in the session", () => {
  it("sendBidEmail refuses before reading a submission or touching a mailbox", async () => {
    const res = await email.sendBidEmail({
      submissionId: UUID,
      accountId: UUID,
      to: "buyer@municipality.gov.za",
      subject: "Bid for tender 14",
      body: "Please find our bid attached.",
      documentIds: [],
    });
    expect(res).toEqual({ ok: false, error: AAL2 });
    expect(h.touched).toEqual([]);
  });

  it("connectSmtp refuses before it signs in to the mail server", async () => {
    const res = await email.connectSmtp({ fromAddress: "bids@acme.co.za", host: "smtp.acme.co.za", port: 587, username: "bids", password: "secret-password" });
    expect(res).toEqual({ ok: false, error: AAL2 });
    expect(h.touched).toEqual([]);
  });

  it("registerDocument refuses before it downloads or deletes anything in Storage", async () => {
    const res = await documents.registerDocument({ docType: "cipc_registration", title: "CIPC", path: "org-1/x/cipc.pdf", expiresAt: null });
    expect(res).toEqual({ ok: false, error: AAL2 });
    expect(h.touched).toEqual([]);
  });

  it("createAutofillToken and createBrowserPairing refuse before a pairing code exists", async () => {
    expect(await autofill.createAutofillToken("laptop")).toEqual({ ok: false, error: AAL2 });
    expect(await autofill.createBrowserPairing("this browser")).toEqual({ ok: false, error: AAL2 });
    expect(h.touched).toEqual([]);
  });

  it("exportOrganisationData refuses before it reads the organisation", async () => {
    expect(await settings.exportOrganisationData()).toEqual({ ok: false, error: AAL2 });
    expect(h.touched).toEqual([]);
  });

  it("the Gmail connection stops at its start and at its callback, and says why", async () => {
    const start = await googleStart.GET(new NextRequest("https://app.tenderos.example/api/email/google/start"));
    expect(new URL(start.headers.get("location")!).pathname + new URL(start.headers.get("location")!).search).toBe("/settings?email=verify");
    expect(start.headers.get("set-cookie")).toBeNull();

    const callback = await googleCallback.GET(new NextRequest("https://app.tenderos.example/api/email/google/callback?code=abc&state=xyz"));
    expect(new URL(callback.headers.get("location")!).search).toBe("?email=verify");
    expect(h.touched).toEqual([]);
  });
});

describe("the check comes after the role check, and passes when the session is fine", () => {
  it("does not ask a viewer about authenticators when they could not do the thing anyway", async () => {
    h.role = "viewer";
    const res = await email.sendBidEmail({
      submissionId: UUID,
      accountId: UUID,
      to: "buyer@municipality.gov.za",
      subject: "Bid for tender 14",
      body: "Please find our bid attached.",
      documentIds: [],
    });
    expect(res).toMatchObject({ ok: false, error: "Only owners and admins can send a bid" });
    expect(h.aal2).not.toHaveBeenCalled();
  });

  it("goes on when requireAal2 allows it", async () => {
    h.aal2.mockResolvedValue(null);
    // The next thing the export does is the person's rate limit, which needs the database client.
    await expect(settings.exportOrganisationData()).rejects.toThrow(/user's database client/);
    expect(h.aal2).toHaveBeenCalledTimes(1);
  });
});
