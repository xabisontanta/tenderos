import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const logged = vi.hoisted(() => [] as unknown[]);
vi.mock("@/lib/log", () => ({
  createLogger: () => {
    const emit = (...args: unknown[]) => void logged.push(args);
    return { debug: emit, info: emit, warn: emit, error: emit, child: () => ({}) };
  },
}));

const { sendTeamInvitation } = await import("@/lib/email/team-invitation");

const TOKEN = `tinv_${"cd34".repeat(16)}`;
const ENV = {
  APP_URL: "https://app.tenderos.example",
  MAIL_FROM: "TenderOS <no-reply@mail.tenderos.example>",
  SMTP_HOST: "smtp.mail.tenderos.example",
  SMTP_USER: "apikey",
  SMTP_PASS: "s3cret",
};

const INPUT = {
  to: "thandi@auditors.example",
  inviterName: "Sipho Dlamini",
  organisationName: "Khumalo Civils (Pty) Ltd",
  role: "viewer" as const,
  token: TOKEN,
  expiresAt: new Date(Date.now() + 7 * 86_400_000),
};

let sent: Array<Record<string, unknown>>;
const factory = async () => ({
  sendMail: async (m: Record<string, unknown>) => {
    sent.push(m);
    return { messageId: "<id@mail>", rejected: [] };
  },
  close: () => undefined,
});

beforeEach(() => {
  sent = [];
});

describe("sendTeamInvitation", () => {
  it("sends the branded invitation email with the accept link built from APP_URL", async () => {
    const res = await sendTeamInvitation(INPUT, { env: ENV, transportFactory: factory });
    expect(res).toEqual({ ok: true, delivered: true, messageId: "<id@mail>" });
    expect(sent).toHaveLength(1);
    const mail = sent[0] as { to: string; subject: string; html: string; text: string };
    expect(mail.to).toBe("thandi@auditors.example");
    expect(mail.subject).toMatch(/Sipho Dlamini invited you to join/);
    expect(mail.subject.length).toBeLessThanOrEqual(78);
    const link = `https://app.tenderos.example/invite/${TOKEN}`;
    expect(mail.html).toContain(link);
    expect(mail.text).toContain(link);
    expect(mail.html).toContain("Khumalo Civils (Pty) Ltd");
    expect(mail.html).toContain("Viewer");
    expect(mail.text).toMatch(/thandi@auditors.example/);
  });

  it("escapes names a person typed", async () => {
    await sendTeamInvitation(
      { ...INPUT, inviterName: `<script>alert(1)</script>`, organisationName: `A & B "Co" <b>` },
      { env: ENV, transportFactory: factory },
    );
    const html = (sent[0] as { html: string }).html;
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("sends nothing and fails plainly when the link would not be https in production", async () => {
    const res = await sendTeamInvitation(INPUT, { env: { ...ENV, NODE_ENV: "production", APP_URL: "http://127.0.0.1:3100" }, transportFactory: factory });
    expect(res).toMatchObject({ ok: false });
    expect(sent).toHaveLength(0);
    // The renderer's own message quotes the link, which carries the token: it must not reach the logs.
    expect(JSON.stringify(logged)).not.toContain("tinv_");
    expect(JSON.stringify(logged)).not.toContain("cd34");
  });

  it("refuses an expired invitation rather than emailing a dead link", async () => {
    const res = await sendTeamInvitation({ ...INPUT, expiresAt: new Date(Date.now() - 1000) }, { env: ENV, transportFactory: factory });
    expect(res).toMatchObject({ ok: false });
    expect(sent).toHaveLength(0);
  });

  it("refuses something that is not a token", async () => {
    const res = await sendTeamInvitation({ ...INPUT, token: "tinv_nope" }, { env: ENV, transportFactory: factory });
    expect(res).toMatchObject({ ok: false });
    expect(sent).toHaveLength(0);
  });

  it("reports that nothing was sent, without failing, when development has no mail server", async () => {
    const res = await sendTeamInvitation(INPUT, { env: { APP_URL: "http://localhost:3000", NODE_ENV: "development" } });
    expect(res).toEqual({ ok: true, delivered: false, messageId: null });
  });
});
