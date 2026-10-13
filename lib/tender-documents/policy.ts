import { isIP } from "node:net";

/** Largest document TenderOS downloads. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
/** The whole download, redirects and body included. */
export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS = 3;
const MAX_URL_CHARS = 2000;

/** Hosts tender documents are fetched from besides the tender's own source host, unless TENDER_DOCUMENT_HOSTS says otherwise. */
export const DEFAULT_DOCUMENT_HOSTS = ["www.etenders.gov.za"] as const;

type Env = Record<string, string | undefined>;

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The hosts a document may be fetched from besides the tender's own source host: TENDER_DOCUMENT_HOSTS, a comma-separated
 * list of bare host names, or www.etenders.gov.za when it is blank. Entries that are not plain host names (addresses,
 * URLs, wildcards) are dropped, and a list with nothing valid in it allows no extra host at all.
 */
export function documentHostAllowList(env: Env = process.env): string[] {
  const raw = env.TENDER_DOCUMENT_HOSTS?.trim();
  if (!raw) return [...DEFAULT_DOCUMENT_HOSTS];
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => HOSTNAME.test(h) && isIP(h) === 0);
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; message: string };

/** Whether a URL is a plain https URL for a named host: no credentials, no explicit port, not an address. */
function plainHttps(u: URL): boolean {
  return u.protocol === "https:" && !u.username && !u.password && u.port === "" && isIP(u.hostname.replace(/^\[|\]$/g, "")) === 0 && HOSTNAME.test(u.hostname);
}

export function parseUrl(raw: string): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_CHARS) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Whether a redirect target may be followed from `from`: still https, still the same host. */
export function sameHostHttps(from: URL, to: URL): boolean {
  return plainHttps(to) && to.hostname === from.hostname;
}

/**
 * Where a document may be fetched from: https, a named host (never an address), no credentials in the URL, no unusual port,
 * and the host is either the tender's own source host or on the allow-list. The message never repeats the URL, which can
 * carry a token.
 */
export function checkDocumentUrl(raw: string, sourceUrl: string | null, allowList: readonly string[]): UrlCheck {
  const url = parseUrl(raw);
  if (!url) return { ok: false, message: "The document link is not a usable web address" };
  if (!plainHttps(url)) return { ok: false, message: "Only plain https links to a named host are fetched" };
  const source = sourceUrl ? parseUrl(sourceUrl) : null;
  const sourceHost = source && plainHttps(source) ? source.hostname : null;
  if (url.hostname !== sourceHost && !allowList.includes(url.hostname)) {
    return { ok: false, message: "The document is hosted somewhere other than the tender's own website, so it was not fetched" };
  }
  return { ok: true, url };
}
