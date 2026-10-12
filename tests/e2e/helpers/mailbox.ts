/**
 * Reads email from the local mail catcher (Mailpit, started with the Supabase
 * stack; its address is the "Inbucket URL" in `supabase status`). Supabase Auth
 * delivers confirmation and reset emails there, so tests can follow the real link.
 */
export const MAILBOX_URL = (process.env.MAILBOX_URL ?? "http://127.0.0.1:56324").replace(/\/$/, "");

export interface Mail {
  id: string;
  subject: string;
  to: string[];
  html: string;
  text: string;
}

interface Body {
  html: string;
  text: string;
}

const decode = (s: string) => s.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");

/** Every link in a message: href values from the HTML part, then bare URLs from the text part. */
export function extractLinks({ html, text }: Body): string[] {
  const found: string[] = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) found.push(decode(m[1]));
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) found.push(m[0].replace(/[.,;:!?]+$/, ""));
  return [...new Set(found)];
}

/** First link matching `pattern`. With `origin`, the link is rewritten to open against that server. */
export function pickLink(body: Body, pattern: RegExp, opts: { origin?: string } = {}): string {
  const links = extractLinks(body);
  const link = links.find((l) => pattern.test(l));
  if (!link) throw new Error(`No link matching ${pattern} in the message. Links found: ${links.join(", ") || "none"}`);
  if (!opts.origin) return link;
  const url = new URL(link);
  return new URL(`${url.pathname}${url.search}${url.hash}`, opts.origin).toString();
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${MAILBOX_URL}${path}`);
  if (!res.ok) throw new Error(`Mail catcher answered ${res.status} for ${path}`);
  return (await res.json()) as T;
}

/** True when the mail catcher answers, so a test can say why it cannot read mail. */
export async function mailboxReachable(): Promise<boolean> {
  try {
    await api("/api/v1/messages?limit=1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits for a message sent to `to` (optionally with a matching subject) and returns the
 * newest. Throws after `timeoutMs` so a missing email fails the test with a clear reason.
 */
export async function waitForMail(to: string, opts: { subject?: RegExp; timeoutMs?: number } = {}): Promise<Mail> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const { messages } = await api<{ messages: Array<{ ID: string; Subject: string; Created: string }> }>(
        `/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
      );
      const match = messages.filter((m) => !opts.subject || opts.subject.test(m.Subject)).sort((a, b) => b.Created.localeCompare(a.Created))[0];
      if (match) {
        const full = await api<{ ID: string; Subject: string; HTML: string; Text: string; To: Array<{ Address: string }> }>(`/api/v1/message/${match.ID}`);
        return { id: full.ID, subject: full.Subject, to: full.To.map((t) => t.Address), html: full.HTML ?? "", text: full.Text ?? "" };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No email for ${to} within ${opts.timeoutMs ?? 20_000} ms${lastError ? ` (last error: ${String(lastError)})` : ""}`);
}
