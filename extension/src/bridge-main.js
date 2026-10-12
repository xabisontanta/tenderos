// @ts-check
/**
 * The bridge between a TenderOS web page and the helper's background worker.
 * Loaded by bridge.js, a content script that matches the TenderOS origin only.
 *
 * It listens for window messages from the page, believes only those posted by
 * the page's own window on the TenderOS origin that pass the strict schema in
 * protocol.js, forwards them to the background worker (which makes every
 * decision and holds the pairing code) and posts acknowledgements back to the
 * TenderOS origin, never to "*". It keeps no state about the pairing code: the
 * code passes through one call and is gone.
 *
 * The logic is a factory over a window and a runtime object so it is
 * unit-tested with fakes (tests/unit/extension-bridge.test.ts).
 */

import { TENDEROS_ORIGIN } from "./config.js";
import { MESSAGE, buildMessage, isTrustedEvent, parseExtensionMessage, parsePageMessage } from "./protocol.js";

/** Messages the bridge answers per window of time; a page cannot flood the background worker. */
const MAX_MESSAGES = 30;
const WINDOW_MS = 10_000;

/**
 * @typedef {Object} BridgeOptions
 * @property {{ addEventListener: (type: "message", fn: (event: any) => void) => void, postMessage: (message: any, targetOrigin: string) => void }} win
 * @property {string} origin  The TenderOS origin messages must come from and go to.
 * @property {{ sendMessage: (message: Record<string, unknown>) => Promise<any> }} runtime
 * @property {string} extensionVersion
 * @property {() => number} [now]
 */

/**
 * Whether the bridge should run in this frame: only the top frame, only on the origin the helper was built for.
 * @param {{ origin: string, expectedOrigin: string, topLevel: boolean }} input
 */
export function shouldStartBridge({ origin, expectedOrigin, topLevel }) {
  return topLevel && origin === expectedOrigin && origin !== "null";
}

/**
 * Removes anything that looks like a pairing code from text meant for the page.
 * @param {unknown} text
 * @returns {string}
 */
function scrub(text) {
  return String(text ?? "")
    .replace(/tos_[a-f0-9]{64}/gi, "[pairing code]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 300);
}

/**
 * @param {unknown} error
 * @returns {{ code: string, message: string }}
 */
function errorInfo(error) {
  const e = error && typeof error === "object" ? /** @type {Record<string, unknown>} */ (error) : {};
  const code = typeof e.code === "string" && /^[a-z_]{2,40}$/.test(e.code) ? e.code : "error";
  const message = scrub(e.message) || "Something went wrong.";
  return { code, message };
}

/** @param {BridgeOptions} options */
export function createBridge({ win, origin, runtime, extensionVersion, now = Date.now }) {
  /** @type {number[]} */
  let recent = [];

  /** @param {Record<string, unknown>} message */
  function post(message) {
    win.postMessage(message, origin);
  }

  /**
   * Posts a message after checking it against the schema the page will apply.
   * @param {string} type
   * @param {Record<string, unknown>} fields
   * @param {string} [nonce]
   */
  function reply(type, fields, nonce) {
    const message = buildMessage(type, nonce ? { ...fields, nonce } : fields);
    if (parseExtensionMessage(message).ok) {
      post(message);
      return;
    }
    if (nonce)
      post(
        buildMessage(type, {
          nonce,
          ok: false,
          error: { code: "bad_reply", message: "The helper gave an answer this page cannot read. Reload the page and try again." },
        }),
      );
  }

  /**
   * Asks the background worker; a worker that is gone or answers badly becomes a plain error.
   * @param {Record<string, unknown>} message
   * @returns {Promise<{ ok: true, data: Record<string, unknown> } | { ok: false, error: { code: string, message: string } }>}
   */
  async function ask(message) {
    let answer;
    try {
      answer = await runtime.sendMessage({ source: "bridge", ...message });
    } catch {
      return {
        ok: false,
        error: { code: "extension_unavailable", message: "The TenderOS browser helper was updated or turned off. Reload this page and try again." },
      };
    }
    if (answer && answer.ok === true) return { ok: true, data: answer.data && typeof answer.data === "object" ? answer.data : {} };
    return { ok: false, error: errorInfo(answer?.error) };
  }

  /** @param {Record<string, unknown>} data */
  const pairingFields = (data) => ({
    paired: data.paired === true,
    tokenId: typeof data.tokenId === "string" ? data.tokenId : null,
    server: typeof data.server === "string" ? data.server : null,
    pairedAt: typeof data.pairedAt === "string" ? data.pairedAt : null,
  });

  /** @param {string} [nonce] */
  async function announce(nonce) {
    const r = await ask({ action: "status" });
    const paired = r.ok && r.data.paired === true;
    reply(MESSAGE.READY, { extensionVersion, paired }, nonce);
  }

  /** @param {Record<string, any>} m */
  async function handle(m) {
    switch (m.type) {
      case MESSAGE.PING:
        return announce(m.nonce);
      case MESSAGE.STATUS: {
        const r = await ask({ action: "status" });
        if (!r.ok) return reply(MESSAGE.STATUS_ACK, { ok: false, paired: false, tokenId: null, server: null, pairedAt: null, error: r.error }, m.nonce);
        return reply(MESSAGE.STATUS_ACK, { ok: true, ...pairingFields(r.data) }, m.nonce);
      }
      case MESSAGE.PAIR: {
        /** @type {Record<string, unknown>} */
        const request = { action: "pair", token: m.token };
        if (m.tokenId) request.tokenId = m.tokenId;
        if (m.label) request.label = m.label;
        const r = await ask(request);
        if (!r.ok) return reply(MESSAGE.PAIR_ACK, { ok: false, error: r.error }, m.nonce);
        /** @type {Record<string, unknown>} */
        const fields = { ok: true };
        if (typeof r.data.organisation === "string") fields.organisation = r.data.organisation.slice(0, 120);
        if (typeof r.data.role === "string") fields.role = r.data.role.slice(0, 20);
        return reply(MESSAGE.PAIR_ACK, fields, m.nonce);
      }
      case MESSAGE.UNPAIR: {
        const r = await ask({ action: "unpair" });
        return reply(MESSAGE.UNPAIR_ACK, r.ok ? { ok: true } : { ok: false, error: r.error }, m.nonce);
      }
      case MESSAGE.APPLY: {
        const r = await ask({ action: "apply", tenderId: m.tenderId, includeSensitive: m.includeSensitive });
        if (!r.ok) return reply(MESSAGE.APPLY_ACK, { ok: false, error: r.error }, m.nonce);
        return reply(MESSAGE.APPLY_ACK, { ok: true, status: r.data.status }, m.nonce);
      }
      default:
        return undefined;
    }
  }

  /** @param {{ source: unknown, origin: string, data: unknown }} event */
  function onMessage(event) {
    if (!isTrustedEvent(event, { win, origin })) return;
    const parsed = parsePageMessage(event.data);
    if (!parsed.ok) return;
    const t = now();
    recent = recent.filter((at) => t - at < WINDOW_MS);
    if (recent.length >= MAX_MESSAGES) return;
    recent.push(t);
    void handle(parsed.message);
  }

  return {
    /** Starts listening and tells the page the helper is here. */
    start() {
      win.addEventListener("message", onMessage);
      void announce();
    },
    /**
     * A progress update from the background worker for the page.
     * @param {Record<string, unknown>} update
     */
    pushStatus(update) {
      const message = buildMessage(MESSAGE.APPLY_STATUS, update);
      if (parseExtensionMessage(message).ok) post(message);
    },
  };
}

/** Runs in the content script: connects the bridge to the real window and the extension runtime. */
export function startBridge() {
  const g = /** @type {any} */ (globalThis);
  if (g.__tenderosBridge) return;
  if (!shouldStartBridge({ origin: location.origin, expectedOrigin: TENDEROS_ORIGIN, topLevel: window === window.top })) return;
  /** @type {any} */
  const runtime = g.chrome.runtime;
  const bridge = createBridge({ win: window, origin: TENDEROS_ORIGIN, runtime, extensionVersion: runtime.getManifest().version });
  g.__tenderosBridge = true;
  bridge.start();
  runtime.onMessage.addListener((/** @type {any} */ message, /** @type {any} */ sender) => {
    // Only the helper's own background worker may push progress to the page.
    if (sender.id !== runtime.id || sender.tab || !message || message.source !== "background" || message.kind !== "apply_status") return;
    const { source: _s, kind: _k, ...update } = message;
    bridge.pushStatus(update);
  });
}
