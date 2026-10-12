// @ts-check
/**
 * The messages TenderOS web pages and the browser helper exchange through
 * window.postMessage (page <-> bridge content script). One module, imported
 * by the extension and by the TenderOS web app, so the two cannot drift.
 * Pure: no chrome APIs, no DOM. Unit-tested in tests/unit/extension-protocol.test.ts.
 *
 * Rules the receiver applies before it believes a message:
 *   1. event.source is the page's own window and event.origin is the TenderOS
 *      origin (isTrustedEvent);
 *   2. the data is a plain object with app "tenderos", this protocol version,
 *      a known type for the direction, and exactly the fields that type
 *      allows, each of the right shape (parsePageMessage / parseExtensionMessage);
 *   3. replies carry the nonce of the request they answer, and the sender
 *      only accepts replies to requests it has pending.
 *
 * Parse failures say which field was wrong, never what it contained, so a
 * pairing code cannot leak through an error.
 */

export const PROTOCOL_VERSION = 1;
export const APP_ID = "tenderos";

export const MESSAGE = Object.freeze({
  PING: "TENDEROS_PING",
  READY: "TENDEROS_EXTENSION_READY",
  PAIR: "TENDEROS_PAIR",
  PAIR_ACK: "TENDEROS_PAIR_ACK",
  STATUS: "TENDEROS_STATUS",
  STATUS_ACK: "TENDEROS_STATUS_ACK",
  UNPAIR: "TENDEROS_UNPAIR",
  UNPAIR_ACK: "TENDEROS_UNPAIR_ACK",
  APPLY: "TENDEROS_APPLY",
  APPLY_ACK: "TENDEROS_APPLY_ACK",
  APPLY_STATUS: "TENDEROS_APPLY_STATUS",
});

/** Progress states the helper reports to the tender page while it prepares a portal form. */
export const APPLY_STATES = Object.freeze(["opening", "waiting_for_form", "confirm_host", "filling", "prepared", "needs_toolbar_click", "failed", "cancelled"]);

export const APPLY_ACK_STATUSES = Object.freeze(["started", "needs_toolbar_click"]);

export const TOKEN_PATTERN = /^tos_[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z0-9.]{1,16})?$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

/**
 * A fresh request id: 128 random bits, hex.
 * @param {{ getRandomValues<T extends ArrayBufferView | null>(array: T): T }} [cryptoObj]
 * @returns {string}
 */
export function newNonce(cryptoObj = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  cryptoObj.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether a window message came from the page itself, on the TenderOS origin.
 * @param {{ source: unknown, origin: string }} event
 * @param {{ win: unknown, origin: string }} expected
 * @returns {boolean}
 */
export function isTrustedEvent(event, expected) {
  if (!expected.origin || expected.origin === "null") return false;
  return event.source === expected.win && event.origin === expected.origin;
}

/** A field checker returns true when the value is acceptable. */
/** @typedef {(value: unknown) => boolean} Check */

/** @param {number} max @returns {Check} */
const text = (max) => (v) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
/** @type {Check} */
const bool = (v) => typeof v === "boolean";
/** @param {number} max @returns {Check} */
const count = (max) => (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
/** @type {Check} */
const nonce = (v) => typeof v === "string" && NONCE_PATTERN.test(v);
/** @type {Check} */
const uuid = (v) => typeof v === "string" && UUID_PATTERN.test(v);
/** @type {Check} */
const token = (v) => typeof v === "string" && TOKEN_PATTERN.test(v);
/** @type {Check} */
const version = (v) => typeof v === "string" && VERSION_PATTERN.test(v);
/** @type {Check} */
const iso = (v) => typeof v === "string" && v.length <= 40 && ISO_PATTERN.test(v);
/** @type {Check} */
const hostName = (v) => typeof v === "string" && HOST_PATTERN.test(v);
/** @param {readonly string[]} values @returns {Check} */
const oneOf = (values) => (v) => typeof v === "string" && values.includes(v);
/** @param {Check} inner @returns {Check} */
const nullable = (inner) => (v) => v === null || inner(v);
/** @type {Check} */
const errorInfo = (v) => {
  if (!isPlainObject(v)) return false;
  const o = /** @type {Record<string, unknown>} */ (v);
  const keys = Object.keys(o);
  return keys.every((k) => k === "code" || k === "message") && /^[a-z_]{2,40}$/.test(String(o.code)) && text(300)(o.message);
};

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * @typedef {{ required: Record<string, Check>, optional?: Record<string, Check> }} Spec
 */

/** @type {Record<string, Spec>} */
const PAGE_SPECS = {
  [MESSAGE.PING]: { required: { nonce } },
  [MESSAGE.STATUS]: { required: { nonce } },
  [MESSAGE.UNPAIR]: { required: { nonce } },
  [MESSAGE.PAIR]: { required: { nonce, token }, optional: { tokenId: uuid, label: text(60) } },
  [MESSAGE.APPLY]: { required: { nonce, tenderId: uuid, includeSensitive: bool } },
};

/** @type {Record<string, Spec>} */
const EXTENSION_SPECS = {
  [MESSAGE.READY]: { required: { extensionVersion: version, paired: bool }, optional: { nonce } },
  [MESSAGE.PAIR_ACK]: { required: { nonce, ok: bool }, optional: { organisation: text(120), role: text(20), error: errorInfo } },
  [MESSAGE.STATUS_ACK]: {
    required: { nonce, ok: bool, paired: bool, tokenId: nullable(uuid), server: nullable(hostName), pairedAt: nullable(iso) },
    optional: { error: errorInfo },
  },
  [MESSAGE.UNPAIR_ACK]: { required: { nonce, ok: bool }, optional: { error: errorInfo } },
  [MESSAGE.APPLY_ACK]: { required: { nonce, ok: bool }, optional: { status: oneOf(APPLY_ACK_STATUSES), error: errorInfo } },
  [MESSAGE.APPLY_STATUS]: {
    required: { tenderId: uuid, state: oneOf(APPLY_STATES), message: text(300) },
    optional: { filled: count(10_000), attached: count(1000), left: count(10_000) },
  },
};

/**
 * @typedef {{ ok: true, message: Record<string, any> } | { ok: false, reason: string }} ParseResult
 */

/**
 * @param {unknown} data
 * @param {Record<string, Spec>} specs
 * @returns {ParseResult}
 */
function parseWith(data, specs) {
  if (!isPlainObject(data)) return { ok: false, reason: "not_an_object" };
  if (data.app !== APP_ID) return { ok: false, reason: "wrong_app" };
  if (data.v !== PROTOCOL_VERSION) return { ok: false, reason: "wrong_version" };
  const type = data.type;
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(specs, type)) return { ok: false, reason: "unknown_type" };
  const spec = /** @type {Spec} */ (specs[type]);
  const optional = spec.optional ?? {};
  /** @type {Record<string, any>} */
  const message = { app: APP_ID, v: PROTOCOL_VERSION, type };
  for (const key of Object.keys(data)) {
    if (key === "app" || key === "v" || key === "type") continue;
    if (!Object.prototype.hasOwnProperty.call(spec.required, key) && !Object.prototype.hasOwnProperty.call(optional, key)) {
      return { ok: false, reason: `unexpected_field:${key.slice(0, 40)}` };
    }
  }
  for (const [key, check] of Object.entries(spec.required)) {
    if (!check(data[key])) return { ok: false, reason: `bad_field:${key}` };
    message[key] = data[key];
  }
  for (const [key, check] of Object.entries(optional)) {
    if (data[key] === undefined) continue;
    if (!check(data[key])) return { ok: false, reason: `bad_field:${key}` };
    message[key] = data[key];
  }
  return { ok: true, message };
}

/**
 * Validates a message a TenderOS page sent to the helper.
 * @param {unknown} data
 * @returns {ParseResult}
 */
export function parsePageMessage(data) {
  return parseWith(data, PAGE_SPECS);
}

/**
 * Validates a message the helper sent to the TenderOS page.
 * @param {unknown} data
 * @returns {ParseResult}
 */
export function parseExtensionMessage(data) {
  return parseWith(data, EXTENSION_SPECS);
}

/**
 * Wraps fields in the envelope every message carries.
 * @param {string} type one of MESSAGE
 * @param {Record<string, unknown>} [fields]
 * @returns {Record<string, unknown>}
 */
export function buildMessage(type, fields = {}) {
  return { ...fields, app: APP_ID, v: PROTOCOL_VERSION, type };
}
