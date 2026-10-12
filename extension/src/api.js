// @ts-check
// TenderOS browser helper: talking to TenderOS. Used by the background worker
// (a trusted extension context). The pairing code never enters a web page:
// content scripts get only the plan and the files.
//
// Every request goes to the one origin this build was made for
// (config.js), with the code as a bearer header, no cookies, no caching and
// no redirects followed. No chrome APIs here, so it is unit-tested with a
// stubbed fetch (tests/unit/extension-api.test.ts).

import { TENDEROS_ORIGIN } from "./config.js";
import { HelperError } from "./errors.js";
import { TOKEN_PATTERN } from "./protocol.js";

export { HelperError, TOKEN_PATTERN };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @typedef {{ server: string, token: string | null }} Settings */

/**
 * @param {unknown} id
 * @param {string} what
 * @returns {string}
 */
function uuid(id, what) {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new HelperError(`That is not a valid ${what}.`, "unprocessable");
  return id;
}

/**
 * @param {string} server
 * @returns {string} the origin, which is always this build's TenderOS origin
 */
function assertServer(server) {
  let origin = "";
  try {
    origin = new URL(server).origin;
  } catch {
    origin = "";
  }
  if (origin !== TENDEROS_ORIGIN) {
    throw new HelperError(`This helper only talks to ${new URL(TENDEROS_ORIGIN).host}.`, "forbidden");
  }
  return origin;
}

/**
 * A short, plain sentence the server wrote for people, or the fallback.
 * @param {Response} res
 * @param {string} fallback
 */
async function serverMessage(res, fallback) {
  try {
    const body = await res.json();
    const message = body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body).error : null;
    if (typeof message === "string" && message.length > 0 && message.length <= 300 && !/[\u0000-\u001f]/.test(message)) return message;
  } catch {
    // Not JSON: use the fallback.
  }
  return fallback;
}

/**
 * @param {Settings} settings
 * @param {string} path  An /api/autofill/... path.
 * @param {{ method?: "GET" | "POST", body?: unknown }} [options]
 * @returns {Promise<Response>}
 */
async function request(settings, path, options = {}) {
  const origin = assertServer(settings.server);
  if (!settings.token || !TOKEN_PATTERN.test(settings.token)) {
    throw new HelperError(
      "This browser is not connected to TenderOS yet. Open TenderOS, go to Settings, Browser helper and press Connect browser.",
      "unauthorized",
    );
  }
  if (!path.startsWith("/api/autofill/") || path.includes("..") || path.includes("//")) throw new HelperError("Unexpected address.", "forbidden");
  const host = new URL(origin).host;
  /** @type {Record<string, string>} */
  const headers = { Authorization: `Bearer ${settings.token}` };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(`${origin}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    throw new HelperError(`Could not reach ${host}. Check your connection and try again.`, "network");
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    throw new HelperError(
      `${host} asked for a sign-in instead of answering the helper. This TenderOS server may not support the browser helper yet.`,
      "invalid_response",
    );
  }
  if (res.status === 401) {
    throw new HelperError(
      "TenderOS did not accept this browser's pairing code. It may have been revoked or expired: connect the browser again in TenderOS, Settings, Browser helper.",
      "unauthorized",
    );
  }
  if (res.status === 429) throw new HelperError("Too many requests. Wait a minute and try again.", "rate_limited");
  if (res.status === 404) throw new HelperError(await serverMessage(res, "TenderOS could not find that. It may have been removed."), "not_found");
  if (res.status === 409) throw new HelperError(await serverMessage(res, "TenderOS cannot do that right now."), "conflict");
  if (res.status === 422) throw new HelperError(await serverMessage(res, "TenderOS could not use that request."), "unprocessable");
  if (!res.ok) throw new HelperError(`TenderOS answered with an error (${res.status}). Try again shortly.`, "server");
  return res;
}

/**
 * @param {Response} res
 * @returns {Promise<unknown>}
 */
async function readJson(res) {
  if (!(res.headers.get("content-type") || "").includes("application/json")) {
    throw new HelperError("TenderOS sent an unexpected answer. Check that the helper matches your TenderOS address.", "invalid_response");
  }
  try {
    return await res.json();
  } catch {
    throw new HelperError("TenderOS sent an unexpected answer. Check that the helper matches your TenderOS address.", "invalid_response");
  }
}

/**
 * Company profile, attachable documents (metadata) and bids awaiting delivery.
 * @param {Settings} settings
 */
export async function fetchPayload(settings) {
  const data = /** @type {any} */ (await readJson(await request(settings, "/api/autofill/profile")));
  if (!data || typeof data !== "object" || !data.profile || !Array.isArray(data.documents) || !Array.isArray(data.bids)) {
    throw new HelperError("TenderOS sent an unexpected answer. Check that the helper matches your TenderOS address.", "invalid_response");
  }
  return data;
}

/**
 * Checks a new pairing code against TenderOS and says who it belongs to.
 * @param {string} server
 * @param {string} token
 * @returns {Promise<{ organisation: string | null, role: string | null }>}
 */
export async function verifyPairing(server, token) {
  const data = /** @type {any} */ (await readJson(await request({ server, token }, "/api/autofill/profile")));
  const name = data?.organisation?.name;
  const role = data?.member?.role;
  return { organisation: typeof name === "string" ? name.slice(0, 120) : null, role: typeof role === "string" ? role.slice(0, 20) : null };
}

/**
 * The raw apply plan for one tender (validate it with parseApplyPlan).
 * @param {Settings} settings
 * @param {string} tenderId
 * @param {boolean} includeSensitive
 * @returns {Promise<unknown>}
 */
export async function fetchApplyPlan(settings, tenderId, includeSensitive) {
  const id = uuid(tenderId, "tender");
  const path = `/api/autofill/tenders/${id}/apply-plan${includeSensitive ? "?sensitive=1" : ""}`;
  return readJson(await request(settings, path));
}

/**
 * Tells TenderOS the portal form was prepared (host and counts only).
 * @param {Settings} settings
 * @param {string} tenderId
 * @param {{ host: string, fields: number, documents: number, left: number, sensitive: boolean, confirmed_host: boolean }} report
 */
export async function postApplyReport(settings, tenderId, report) {
  const id = uuid(tenderId, "tender");
  await request(settings, `/api/autofill/tenders/${id}/apply-report`, { method: "POST", body: report });
}

/**
 * One document's bytes, base64-encoded so they can be handed to the content script.
 * @param {Settings} settings
 * @param {string} id
 * @returns {Promise<{ base64: string, size: number, type: string }>}
 */
export async function fetchDocument(settings, id) {
  const res = await request(settings, `/api/autofill/documents/${encodeURIComponent(uuid(id, "document"))}`);
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
