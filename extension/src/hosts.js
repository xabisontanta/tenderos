// @ts-check
/**
 * Host rules for the TenderOS browser helper. Pure functions only (no chrome
 * APIs, no DOM), unit-tested in tests/unit/extension-hosts.test.ts.
 *
 * The helper only fills a page whose site matches the portal TenderOS named
 * for the tender. "Site" means the registrable domain, so a portal that moves
 * between www.example.gov.za and secure.example.gov.za still matches, while
 * example.gov.za.evil.com and a sibling registration under a public suffix do
 * not. The suffix list is deliberately small (South Africa first) and errs
 * towards treating unknown country-code second levels as suffixes.
 */

/** Longest address the helper will open or compare. */
export const MAX_URL_LENGTH = 2000;
const MAX_HOST_LENGTH = 253;

const MULTI_LABEL_SUFFIXES = new Set([
  // South Africa
  "co.za",
  "org.za",
  "gov.za",
  "ac.za",
  "net.za",
  "web.za",
  "nom.za",
  "edu.za",
  "mil.za",
  "ngo.za",
  "law.za",
  "school.za",
  "agric.za",
  "alt.za",
  "cri.za",
  "grondar.za",
  "nis.za",
  "tm.za",
  // Neighbours and common others
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "com.au",
  "gov.au",
  "org.au",
  "edu.au",
  "co.nz",
  "govt.nz",
  "co.zw",
  "co.ke",
  "co.bw",
  "co.na",
  "co.zm",
  "co.ls",
  "co.sz",
  "com.ng",
  "gov.ng",
  "co.in",
  "gov.in",
  "com.br",
]);

/** Second-level labels that countries put under their two-letter domain (co.xx, gov.xx, ...). */
const GENERIC_SECOND_LEVELS = new Set(["co", "com", "org", "net", "gov", "govt", "ac", "edu", "or", "ne", "go", "sch", "mil"]);

/**
 * Lower-case host without a trailing dot.
 * @param {string} host
 */
function clean(host) {
  return String(host || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

/** @param {string} host */
function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
}

/**
 * Loopback names only (localhost, 127.0.0.1, ::1 and *.localhost).
 * @param {string} host
 * @returns {boolean}
 */
export function isLocalhost(host) {
  const h = clean(host);
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h.endsWith(".localhost");
}

/**
 * The part of a host a person would call "the site": www.etenders.gov.za -> etenders.gov.za.
 * IP literals, localhost and single-label hosts are returned as they are.
 * @param {string} host
 * @returns {string}
 */
export function registrableDomain(host) {
  const h = clean(host);
  if (!h || isIpLiteral(h) || !h.includes(".")) return h;
  const labels = h.split(".");
  const last = /** @type {string} */ (labels[labels.length - 1]);
  const second = /** @type {string} */ (labels[labels.length - 2]);
  const twoLabel = `${second}.${last}`;
  const suffixLabels = MULTI_LABEL_SUFFIXES.has(twoLabel) || (last.length === 2 && GENERIC_SECOND_LEVELS.has(second)) ? 3 : 2;
  return labels.slice(-suffixLabels).join(".");
}

/**
 * How two hosts relate: the very same host, the same site (registrable domain) or different sites.
 * @param {string} expectedHost
 * @param {string} actualHost
 * @returns {"same_host"|"same_site"|"different"}
 */
export function compareHosts(expectedHost, actualHost) {
  const a = clean(expectedHost);
  const b = clean(actualHost);
  if (a && a === b) return "same_host";
  if (a && b && registrableDomain(a) === registrableDomain(b)) return "same_site";
  return "different";
}

/**
 * @typedef {{ ok: true, url: string, host: string, origin: string } | { ok: false, reason: "invalid"|"scheme"|"credentials"|"host"|"too_long" }} PortalUrlResult
 */

/**
 * A web address the helper may open or fill: https only (http and https on
 * localhost when the build allows it), no credentials in the address, a real
 * public-looking host name (no IP addresses, no single-label intranet names).
 * The fragment is dropped.
 * @param {unknown} input
 * @param {{ allowLocalhost?: boolean }} [options]
 * @returns {PortalUrlResult}
 */
export function parsePortalUrl(input, options = {}) {
  if (typeof input !== "string") return { ok: false, reason: "invalid" };
  const text = input.trim();
  if (!text) return { ok: false, reason: "invalid" };
  if (text.length > MAX_URL_LENGTH) return { ok: false, reason: "too_long" };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const host = clean(url.hostname);
  const local = isLocalhost(host);
  if (local) {
    if (!options.allowLocalhost) return { ok: false, reason: "host" };
    if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "scheme" };
  } else {
    if (url.protocol !== "https:") return { ok: false, reason: "scheme" };
    if (isIpLiteral(host) || !host.includes(".")) return { ok: false, reason: "host" };
  }
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (!host || host.length > MAX_HOST_LENGTH) return { ok: false, reason: "host" };
  url.hash = "";
  return { ok: true, url: url.href, host, origin: url.origin };
}

/**
 * Whether the helper may fill the page a tab is showing.
 *  - match: the tab is on the expected site; fill.
 *  - confirm: another site; the person must confirm, with both hosts named.
 *  - refuse: not a page the helper fills at all (not https, browser pages, unreadable).
 * @param {{ expectedHost: string, tabUrl: string | undefined, allowLocalhost?: boolean }} input
 * @returns {{ decision: "match" } | { decision: "confirm", expectedHost: string, tabHost: string } | { decision: "refuse", reason: string, message: string }}
 */
export function evaluateTarget({ expectedHost, tabUrl, allowLocalhost = false }) {
  if (!tabUrl) {
    return { decision: "refuse", reason: "unreadable", message: "The helper cannot read this page's address, so it will not fill it." };
  }
  const page = parsePortalUrl(tabUrl, { allowLocalhost });
  if (!page.ok) {
    return {
      decision: "refuse",
      reason: page.reason,
      message: "The helper only fills secure (https) web pages, not browser pages, files or addresses without a proper web site name.",
    };
  }
  if (compareHosts(expectedHost, page.host) === "different") return { decision: "confirm", expectedHost, tabHost: page.host };
  return { decision: "match" };
}
