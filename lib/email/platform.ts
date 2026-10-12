import "server-only";

import nodemailer from "nodemailer";
import { createLogger } from "@/lib/log";
import { resolvePublicHost, SMTP_PORTS } from "./network";

/**
 * TenderOS's own mailer, for the emails the app sends itself (team invitations today). It is not the
 * customer's mailbox (that sends bids, `smtp.ts` and `gmail.ts`) and not Supabase Auth's mailer (sign-up and
 * password emails, set in the Supabase project). Provider-neutral: any SMTP submission service, configured
 * with MAIL_FROM and SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (docs/email.md).
 *
 *   - TLS 1.2 or later, certificate checked against the host name, port 465/587/2525 only.
 *   - The host must resolve to public addresses (`network.ts`), and the connection goes to the checked address.
 *   - Not configured: in development it sends nothing and says so (tests and local work need no server); in
 *     production it logs an error that names the missing variables and reports a failure to the caller, so an
 *     invitation is never silently lost.
 *   - Nothing here logs a recipient, a subject, a body or a credential.
 */
const log = createLogger({ module: "platform-mail" });

type Env = Record<string, string | undefined>;

export interface PlatformMailSettings {
  /** The From header: an address, or `Name <address>`. */
  from: string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

export interface PlatformMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** What kind of email this is, for logs ("team_invitation"). Never the content. */
  kind: string;
}

export type PlatformMailResult = { ok: true; delivered: boolean; messageId: string | null } | { ok: false; error: string };

export interface PlatformTransport {
  sendMail(message: Record<string, unknown>): Promise<{ messageId?: string; rejected?: unknown[] }>;
  close(): void;
}

export interface PlatformMailDeps {
  env?: Env;
  transportFactory?: (settings: PlatformMailSettings) => Promise<PlatformTransport>;
}

const blank = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : v.trim());

/** A sender is `address` or `Name <address>`, on one line. */
const SENDER = /^(?:[^<>\r\n"]{1,100}\s)?<?[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}>?$/i;

/**
 * The mailer's settings from the environment, or null when none are set (blank placeholders count as unset).
 * Half-set or invalid configuration throws with the variable named, so it is never mistaken for "off".
 */
export function platformMailSettings(env: Env = process.env): PlatformMailSettings | null {
  const from = blank(env.MAIL_FROM);
  const host = blank(env.SMTP_HOST);
  if (!from && !host) return null;
  if (!from) throw new Error("MAIL_FROM is required when SMTP_HOST is set");
  if (!host) throw new Error("SMTP_HOST is required when MAIL_FROM is set");
  if (!SENDER.test(from)) throw new Error("MAIL_FROM must be an address such as no-reply@example.com, or Name <no-reply@example.com>");
  const port = Number(blank(env.SMTP_PORT) ?? 587);
  if (!(SMTP_PORTS as readonly number[]).includes(port)) throw new Error(`SMTP_PORT must be one of ${SMTP_PORTS.join(", ")}`);
  const username = blank(env.SMTP_USER) ?? null;
  const password = blank(env.SMTP_PASS) ?? null;
  if ((username === null) !== (password === null)) throw new Error("SMTP_USER and SMTP_PASS must be set together");
  return { from, host, port, username, password };
}

/** Connection options: the address that was checked, TLS 1.2+, the certificate validated for the host name. */
export function platformTransportOptions(s: PlatformMailSettings, address: string) {
  return {
    host: address,
    port: s.port,
    secure: s.port === 465,
    requireTLS: s.port !== 465,
    ...(s.username !== null && s.password !== null ? { auth: { user: s.username, pass: s.password } } : {}),
    tls: { servername: s.host, minVersion: "TLSv1.2" as const, rejectUnauthorized: true },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  };
}

async function defaultTransport(s: PlatformMailSettings): Promise<PlatformTransport> {
  const address = await resolvePublicHost(s.host);
  return nodemailer.createTransport(platformTransportOptions(s, address)) as unknown as PlatformTransport;
}

export async function sendPlatformEmail(mail: PlatformMail, deps: PlatformMailDeps = {}): Promise<PlatformMailResult> {
  const env = deps.env ?? process.env;

  let settings: PlatformMailSettings | null;
  try {
    settings = platformMailSettings(env);
  } catch (err) {
    log.error(`platform email is misconfigured: ${(err as Error).message}`, { kind: mail.kind });
    return { ok: false, error: "Email is set up incorrectly on this server, so nothing was sent" };
  }

  if (!settings) {
    if (env.NODE_ENV === "production") {
      log.error("platform email is not configured: set MAIL_FROM, SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS", { kind: mail.kind });
      return { ok: false, error: "Email is not set up on this server, so nothing was sent" };
    }
    log.info("platform email not sent: SMTP is not configured (development)", { kind: mail.kind });
    return { ok: true, delivered: false, messageId: null };
  }

  let transport: PlatformTransport | null = null;
  try {
    transport = await (deps.transportFactory ?? defaultTransport)(settings);
    const info = await transport.sendMail({
      from: settings.from,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" },
    });
    if (info.rejected?.length) {
      log.warn("platform email was rejected by the server", { kind: mail.kind });
      return { ok: false, error: "The email could not be sent" };
    }
    return { ok: true, delivered: true, messageId: info.messageId ?? null };
  } catch (err) {
    log.error("platform email failed", { kind: mail.kind, code: (err as { code?: string }).code ?? "unknown" });
    return { ok: false, error: "The email could not be sent" };
  } finally {
    transport?.close();
  }
}
