// TenderOS browser helper: talking to TenderOS. Used by the background
// worker and the popup (both trusted extension contexts). The pairing code
// never enters a web page: content scripts get only the plan and the files.

export const DEFAULT_SERVER = "https://tenderos-six.vercel.app";
export const TOKEN_PATTERN = /^tos_[a-f0-9]{64}$/;

/** Hosts the manifest already allows; any other https server is asked for at runtime. */
export const BUILT_IN_SERVERS = ["https://tenderos-six.vercel.app", "http://localhost:3000"];

/** An error whose message is written for the person using the helper. */
export class HelperError extends Error {}

/**
 * The origin of a TenderOS server address, or a HelperError explaining what is wrong.
 * @param {string} input
 * @returns {string}
 */
export function normaliseServer(input) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new HelperError(`Enter the TenderOS address, e.g. ${DEFAULT_SERVER}`);
  }
  if (url.username || url.password) throw new HelperError("Enter the address without a user name or password.");
  const local = url.protocol === "http:" && url.hostname === "localhost" && url.port === "3000";
  if (url.protocol !== "https:" && !local) throw new HelperError("Use an https:// address (http is only allowed for http://localhost:3000).");
  return url.origin;
}

/** @returns {Promise<{ server: string, token: string|null }>} */
export async function getSettings() {
  const { server, token } = await chrome.storage.local.get(["server", "token"]);
  return {
    server: typeof server === "string" && server ? server : DEFAULT_SERVER,
    token: typeof token === "string" && TOKEN_PATTERN.test(token) ? token : null,
  };
}

/**
 * @param {{ server: string, token: string|null }} settings
 * @param {string} path
 */
async function request(settings, path) {
  if (!settings.token) throw new HelperError("Pair the helper first: paste a pairing code from TenderOS Settings → Browser helper.");
  const host = new URL(settings.server).host;
  let res;
  try {
    res = await fetch(`${settings.server}${path}`, {
      headers: { Authorization: `Bearer ${settings.token}` },
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    throw new HelperError(`Could not reach ${host}. Check the address and your connection.`);
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    throw new HelperError(`${host} asked for a sign-in instead of answering the helper. This TenderOS server may not support the browser helper yet.`);
  }
  if (res.status === 401)
    throw new HelperError("TenderOS did not accept the pairing code. It may have been revoked or expired: create a new one in Settings → Browser helper.");
  if (res.status === 429) throw new HelperError("Too many requests. Wait a minute and try again.");
  if (!res.ok) {
    let message = "";
    try {
      message = String((await res.json()).error || "");
    } catch {
      message = "";
    }
    throw new HelperError(message || `TenderOS answered with an error (${res.status}).`);
  }
  return res;
}

/**
 * Company profile, attachable documents (metadata) and bids awaiting delivery.
 * @param {{ server: string, token: string|null }} settings
 */
export async function fetchPayload(settings) {
  const res = await request(settings, "/api/autofill/profile");
  if (!(res.headers.get("content-type") || "").includes("application/json")) {
    throw new HelperError("TenderOS sent an unexpected answer. Check the server address.");
  }
  const data = await res.json();
  if (!data || typeof data !== "object" || !data.profile || !Array.isArray(data.documents) || !Array.isArray(data.bids)) {
    throw new HelperError("TenderOS sent an unexpected answer. Check the server address.");
  }
  return data;
}

/**
 * One document's bytes, base64-encoded so they can be handed to the content script.
 * @param {{ server: string, token: string|null }} settings
 * @param {string} id
 * @returns {Promise<{ base64: string, size: number, type: string }>}
 */
export async function fetchDocument(settings, id) {
  const res = await request(settings, `/api/autofill/documents/${encodeURIComponent(id)}`);
  const buf = await res.arrayBuffer();
  return { base64: toBase64(buf), size: buf.byteLength, type: res.headers.get("content-type") || "application/octet-stream" };
}

/** @param {ArrayBuffer} buf */
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
