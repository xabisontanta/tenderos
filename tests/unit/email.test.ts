import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { isPrivateAddress, resolvePublicHost } = await import("@/lib/email/network");
const { buildRawMessage } = await import("@/lib/email/compose");
const { googleAuthUrl } = await import("@/lib/email/gmail");

describe("SMTP host checks", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])(
    "treats %s as private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );

  it.each(["8.8.8.8", "41.0.0.1", "2001:4860:4860::8888"])("treats %s as public", (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it("refuses IP literals, bare names and hosts that resolve to private addresses", async () => {
    await expect(resolvePublicHost("10.0.0.5")).rejects.toThrow(/host name/);
    await expect(resolvePublicHost("localhost")).rejects.toThrow(/host name/);
    await expect(resolvePublicHost("localhost.")).rejects.toThrow();
  });
});

describe("bid email composition", () => {
  it("builds a MIME message with the sender, recipient and every attachment", async () => {
    const raw = (
      await buildRawMessage({
        from: { address: "tenders@acme.co.za", name: "Acme (Pty) Ltd" },
        to: "bids@municipality.gov.za",
        subject: "Bid submission: RFQ 12/2026",
        text: "Please find attached our bid.",
        attachments: [{ filename: "cipc.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4 test") }],
      })
    ).toString();
    expect(raw).toMatch(/From: "Acme \(Pty\) Ltd" <tenders@acme.co.za>/);
    expect(raw).toMatch(/To: bids@municipality.gov.za/);
    expect(raw).toMatch(/filename=cipc.pdf/);
    expect(raw).toContain(Buffer.from("%PDF-1.4 test").toString("base64"));
  });
});

describe("Gmail consent", () => {
  it("asks for send-only access with PKCE and offline refresh", () => {
    const url = new URL(googleAuthUrl({ clientId: "client" }, "https://app.example/api/email/google/callback", "state123", "challenge"));
    expect(url.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/gmail.send");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("state123");
  });
});
