import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  logs: [] as Array<{ level: string; msg: string; fields: unknown }>,
}));

vi.mock("@/lib/log", () => ({
  createLogger: () => {
    const emit = (level: string) => (msg: string, fields?: unknown) => void h.logs.push({ level, msg, fields });
    return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error"), child: () => ({}) };
  },
}));

const { platformMailSettings, platformTransportOptions, sendPlatformEmail } = await import("@/lib/email/platform");

const CONFIGURED = {
  MAIL_FROM: "TenderOS <no-reply@mail.tenderos.example>",
  SMTP_HOST: "smtp.mail.tenderos.example",
  SMTP_PORT: "587",
  SMTP_USER: "apikey",
  SMTP_PASS: "s3cret-password",
};

const MESSAGE = { to: "invitee@client.example", subject: "Invitation", html: "<p>Hi</p>", text: "Hi", kind: "team_invitation" };

beforeEach(() => {
  h.logs.length = 0;
});

describe("platformMailSettings", () => {
  it("reads the sender and the server from MAIL_FROM and SMTP_*", () => {
    expect(platformMailSettings(CONFIGURED)).toEqual({
      from: "TenderOS <no-reply@mail.tenderos.example>",
      host: "smtp.mail.tenderos.example",
      port: 587,
      username: "apikey",
      password: "s3cret-password",
    });
  });

  it("treats blank placeholders as not configured, and a bare address as a valid sender", () => {
    expect(platformMailSettings({ MAIL_FROM: "", SMTP_HOST: " ", SMTP_PORT: "587", SMTP_USER: "", SMTP_PASS: "" })).toBeNull();
    expect(platformMailSettings({})).toBeNull();
    expect(platformMailSettings({ ...CONFIGURED, MAIL_FROM: "no-reply@mail.tenderos.example" })?.from).toBe("no-reply@mail.tenderos.example");
  });

  it("defaults the port to 587 and allows a relay without a login", () => {
    const s = platformMailSettings({ MAIL_FROM: CONFIGURED.MAIL_FROM, SMTP_HOST: CONFIGURED.SMTP_HOST });
    expect(s).toMatchObject({ port: 587, username: null, password: null });
  });

  it.each([
    ["a sender without an address", { ...CONFIGURED, MAIL_FROM: "TenderOS" }],
    ["a header-injection sender", { ...CONFIGURED, MAIL_FROM: "a@b.example\r\nBcc: x@y.example" }],
    ["a server but no sender", { ...CONFIGURED, MAIL_FROM: "" }],
    ["a sender but no server", { ...CONFIGURED, SMTP_HOST: "" }],
    ["port 25", { ...CONFIGURED, SMTP_PORT: "25" }],
    ["a port that is not a number", { ...CONFIGURED, SMTP_PORT: "mail" }],
    ["a user without a password", { ...CONFIGURED, SMTP_PASS: "" }],
    ["a password without a user", { ...CONFIGURED, SMTP_USER: "" }],
  ])("refuses %s", (_label, env) => {
    expect(() => platformMailSettings(env)).toThrow();
  });
});

describe("platformTransportOptions", () => {
  it("connects to the checked address, validates the certificate for the host name, and needs TLS 1.2 or later", () => {
    const o = platformTransportOptions(platformMailSettings(CONFIGURED)!, "203.0.113.9");
    expect(o).toMatchObject({
      host: "203.0.113.9",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: "apikey", pass: "s3cret-password" },
      tls: { servername: "smtp.mail.tenderos.example", minVersion: "TLSv1.2", rejectUnauthorized: true },
    });
  });

  it("uses implicit TLS on 465 and no login when none is set", () => {
    const o = platformTransportOptions({ from: "a@b.example", host: "smtp.b.example", port: 465, username: null, password: null }, "203.0.113.9");
    expect(o).toMatchObject({ secure: true, requireTLS: false });
    expect(o).not.toHaveProperty("auth");
  });
});

describe("sendPlatformEmail", () => {
  it("sends through the transport with the configured sender, a plain-text twin and no tracking headers", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<abc@mail>", rejected: [] });
    const close = vi.fn();
    const res = await sendPlatformEmail(MESSAGE, { env: CONFIGURED, transportFactory: async () => ({ sendMail, close }) });
    expect(res).toEqual({ ok: true, delivered: true, messageId: "<abc@mail>" });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: CONFIGURED.MAIL_FROM,
        to: "invitee@client.example",
        subject: "Invitation",
        html: "<p>Hi</p>",
        text: "Hi",
        headers: expect.objectContaining({ "Auto-Submitted": "auto-generated" }),
      }),
    );
    expect(close).toHaveBeenCalled();
  });

  it("reports a rejected recipient or a failing server as a failure, never as a send", async () => {
    const rejected = await sendPlatformEmail(MESSAGE, {
      env: CONFIGURED,
      transportFactory: async () => ({ sendMail: vi.fn().mockResolvedValue({ messageId: "x", rejected: ["invitee@client.example"] }), close: vi.fn() }),
    });
    expect(rejected).toMatchObject({ ok: false });
    const down = await sendPlatformEmail(MESSAGE, {
      env: CONFIGURED,
      transportFactory: async () => ({
        sendMail: vi.fn().mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
        close: vi.fn(),
      }),
    });
    expect(down).toEqual({ ok: false, error: "The email could not be sent" });
  });

  it("in development without SMTP it sends nothing, says so, and needs no server", async () => {
    const factory = vi.fn();
    const res = await sendPlatformEmail(MESSAGE, { env: { NODE_ENV: "development" }, transportFactory: factory });
    expect(res).toEqual({ ok: true, delivered: false, messageId: null });
    expect(factory).not.toHaveBeenCalled();
    expect(h.logs.some((l) => l.level === "info" && /not configured/i.test(l.msg))).toBe(true);
  });

  it("in production without SMTP it fails loudly: an error log naming the variables, and a failure for the caller", async () => {
    const factory = vi.fn();
    const res = await sendPlatformEmail(MESSAGE, { env: { NODE_ENV: "production" }, transportFactory: factory });
    expect(res).toMatchObject({ ok: false });
    expect(factory).not.toHaveBeenCalled();
    const error = h.logs.find((l) => l.level === "error");
    expect(error?.msg).toMatch(/MAIL_FROM/);
    expect(error?.msg).toMatch(/SMTP_HOST/);
  });

  it("fails on half-set configuration in any environment, naming the problem", async () => {
    const res = await sendPlatformEmail(MESSAGE, { env: { NODE_ENV: "development", MAIL_FROM: "a@b.example" } });
    expect(res).toMatchObject({ ok: false });
    expect(h.logs.some((l) => l.level === "error")).toBe(true);
  });

  it("refuses a mail server that is a private address or a bare IP, without connecting", async () => {
    for (const host of ["127.0.0.1", "localhost", "10.0.0.5", "169.254.169.254"]) {
      const res = await sendPlatformEmail(MESSAGE, { env: { ...CONFIGURED, SMTP_HOST: host } });
      expect(res, host).toMatchObject({ ok: false });
    }
  });

  it("never logs the recipient, the subject, the body or the password", async () => {
    const failing = async () => ({ sendMail: vi.fn().mockRejectedValue(new Error("550 invitee@client.example rejected")), close: vi.fn() });
    await sendPlatformEmail(MESSAGE, { env: CONFIGURED, transportFactory: failing });
    await sendPlatformEmail(MESSAGE, { env: { NODE_ENV: "development" } });
    await sendPlatformEmail(MESSAGE, { env: { NODE_ENV: "production" } });
    const text = JSON.stringify(h.logs);
    for (const secret of ["invitee@client.example", "Invitation", "<p>Hi</p>", "s3cret-password"]) expect(text).not.toContain(secret);
  });
});
