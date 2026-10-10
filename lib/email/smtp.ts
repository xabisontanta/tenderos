import "server-only";

import nodemailer from "nodemailer";
import { nodemailerMessage, type OutgoingEmail } from "./compose";
import { resolvePublicHost } from "./network";

export interface SmtpSettings {
  host: string;
  port: number;
  username: string;
  password: string;
}

async function transport(s: SmtpSettings) {
  const address = await resolvePublicHost(s.host);
  return nodemailer.createTransport({
    host: address,
    port: s.port,
    secure: s.port === 465,
    requireTLS: s.port !== 465,
    auth: { user: s.username, pass: s.password },
    // Connect by address (checked above) but validate the certificate for the name.
    tls: { servername: s.host, minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
}

/** Logs in to the server without sending anything, so bad settings fail on save, not at bid time. */
export async function verifySmtp(s: SmtpSettings): Promise<void> {
  const t = await transport(s);
  try {
    await t.verify();
  } catch (err) {
    throw new Error(`Could not sign in to ${s.host}:${s.port}. Check the server, port, username and password. (${(err as Error).message.slice(0, 160)})`);
  } finally {
    t.close();
  }
}

export async function sendWithSmtp(s: SmtpSettings, message: OutgoingEmail) {
  const t = await transport(s);
  try {
    const info = await t.sendMail(nodemailerMessage(message));
    if (info.rejected.length) throw new Error(`The mail server rejected ${info.rejected.join(", ")}`);
    return { messageId: info.messageId };
  } finally {
    t.close();
  }
}
