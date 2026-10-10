import "server-only";

import { buildRawMessage, type OutgoingEmail } from "./compose";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const SEND_URL = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";
export const OAUTH_COOKIE = "tenderos_google_oauth";

/** Send-only access: TenderOS cannot read anyone's mailbox. */
export const GMAIL_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.send"];

export function googleConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function googleAuthUrl(cfg: { clientId: string }, redirectUri: string, state: string, codeChallenge: string, loginHint?: string) {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (loginHint) q.set("login_hint", loginHint);
  return `${AUTH_URL}?${q}`;
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (json.error === "invalid_grant")
    throw new Error("Google no longer accepts this connection; disconnect the Gmail mailbox in Settings and connect it again");
  if (!res.ok) throw new Error(`Google refused the request (${String(json.error ?? res.status)})`);
  return json as { access_token: string; refresh_token?: string; scope?: string };
}

/** Exchanges the consent code and returns the refresh token and the Gmail address it belongs to. */
export async function exchangeGoogleCode(cfg: { clientId: string; clientSecret: string }, code: string, verifier: string, redirectUri: string) {
  const t = await tokenRequest({
    code,
    code_verifier: verifier,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (!t.refresh_token) throw new Error("Google did not grant offline access; remove TenderOS from your Google account permissions and connect again");
  if (!t.scope?.split(" ").includes("https://www.googleapis.com/auth/gmail.send")) throw new Error("Permission to send email was not granted");
  const info = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(15_000) });
  const user = (await info.json().catch(() => ({}))) as { email?: string; email_verified?: boolean };
  if (!info.ok || !user.email || user.email_verified === false) throw new Error("Could not confirm the Gmail address");
  return { refreshToken: t.refresh_token, email: user.email.toLowerCase() };
}

export async function sendWithGmail(cfg: { clientId: string; clientSecret: string }, refreshToken: string, message: OutgoingEmail) {
  const { access_token } = await tokenRequest({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const raw = await buildRawMessage(message);
  const res = await fetch(SEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${access_token}`, "content-type": "message/rfc822" },
    body: new Uint8Array(raw),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok || !json.id) throw new Error(`Gmail did not send the email: ${json.error?.message ?? res.status}`);
  return { messageId: json.id };
}
