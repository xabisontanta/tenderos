// @ts-check
/**
 * The pairing handshake as a pure state machine. The background worker feeds
 * it events (a page asked to pair, TenderOS accepted or refused the code, the
 * person disconnected, a later request got a 401) and carries out the effects
 * it returns (verify the code with TenderOS, store it, clear it). Unit-tested
 * in tests/unit/extension-pairing.test.ts.
 *
 * The pairing code appears only in events and effects, never in a state, so
 * nothing that is logged, shown or sent back to a page can contain it.
 * The server a code is paired with is always the origin this helper was built
 * for; a page cannot name another one.
 */

import { TOKEN_PATTERN } from "./protocol.js";

/**
 * @typedef {Object} PairingState
 * @property {"unpaired"|"pairing"|"paired"} status
 * @property {string | null} server  Origin the code belongs to (paired only).
 * @property {string | null} tokenId  Row id of the code in TenderOS, when the page told us.
 * @property {string | null} label
 * @property {string | null} pairedAt
 * @property {string | null} organisation
 * @property {string | null} role
 * @property {{ code: string, message: string } | null} error  Why the last attempt failed, if it did.
 * @property {{ tokenId: string | null, label: string | null, now: string } | null} pending  The attempt being verified.
 * @property {PairingState | null} previous  The pairing to fall back to if the attempt fails.
 */

/**
 * @typedef {{ type: "pair_requested", origin: string, token: string, tokenId?: string | null, label?: string | null, now: string }
 *   | { type: "verified", token: string, organisation?: string | null, role?: string | null }
 *   | { type: "verify_failed", error: { code: string, message: string } }
 *   | { type: "unpair_requested" }
 *   | { type: "token_rejected" }} PairingEvent
 */

/**
 * @typedef {{ type: "verify", server: string, token: string }
 *   | { type: "store", record: { server: string, token: string, tokenId: string | null, pairedAt: string, label: string } }
 *   | { type: "clear" }} PairingEffect
 */

/** What the background keeps in storage (the only place the code lives). */
/** @typedef {{ server: string, token: string, tokenId: string | null, pairedAt: string | null, label: string | null }} StoredPairing */

/** @param {{ code: string, message: string } | null} [error] @returns {PairingState} */
function unpaired(error = null) {
  return { status: "unpaired", server: null, tokenId: null, label: null, pairedAt: null, organisation: null, role: null, error, pending: null, previous: null };
}

/**
 * @param {StoredPairing | null | undefined} stored
 * @param {string} allowedOrigin
 * @returns {PairingState}
 */
export function initialPairing(stored, allowedOrigin) {
  if (!stored || stored.server !== allowedOrigin || !TOKEN_PATTERN.test(stored.token)) return unpaired();
  return {
    status: "paired",
    server: stored.server,
    tokenId: stored.tokenId ?? null,
    label: stored.label ?? null,
    pairedAt: stored.pairedAt ?? null,
    organisation: null,
    role: null,
    error: null,
    pending: null,
    previous: null,
  };
}

/**
 * @param {PairingState} state
 * @param {PairingEvent} event
 * @param {string} allowedOrigin The TenderOS origin this build talks to.
 * @returns {{ state: PairingState, effects: PairingEffect[], rejected?: "busy"|"wrong_origin"|"bad_token" }}
 */
export function reducePairing(state, event, allowedOrigin) {
  switch (event.type) {
    case "pair_requested": {
      if (state.status === "pairing") return { state, effects: [], rejected: "busy" };
      if (event.origin !== allowedOrigin) {
        const error = { code: "wrong_origin", message: "This page is not the TenderOS address this helper was built for." };
        return { state: { ...state, error }, effects: [], rejected: "wrong_origin" };
      }
      if (!TOKEN_PATTERN.test(event.token)) {
        const error = { code: "bad_token", message: "That is not a TenderOS pairing code." };
        return { state: { ...state, error }, effects: [], rejected: "bad_token" };
      }
      return {
        state: {
          ...unpaired(),
          status: "pairing",
          pending: { tokenId: event.tokenId ?? null, label: event.label ?? null, now: event.now },
          previous: state.status === "paired" ? { ...state, error: null } : null,
        },
        effects: [{ type: "verify", server: allowedOrigin, token: event.token }],
      };
    }
    case "verified": {
      if (state.status !== "pairing" || !state.pending) return { state, effects: [] };
      const { pending } = state;
      const label = pending.label || "This browser";
      return {
        state: {
          status: "paired",
          server: allowedOrigin,
          tokenId: pending.tokenId,
          label,
          pairedAt: pending.now,
          organisation: event.organisation ?? null,
          role: event.role ?? null,
          error: null,
          pending: null,
          previous: null,
        },
        effects: [{ type: "store", record: { server: allowedOrigin, token: event.token, tokenId: pending.tokenId, pairedAt: pending.now, label } }],
      };
    }
    case "verify_failed": {
      if (state.status !== "pairing") return { state, effects: [] };
      return { state: { ...(state.previous ?? unpaired()), error: event.error }, effects: [] };
    }
    case "unpair_requested":
      return { state: unpaired(), effects: [{ type: "clear" }] };
    case "token_rejected": {
      if (state.status !== "paired") return { state, effects: [] };
      return {
        state: unpaired({ code: "unauthorized", message: "TenderOS no longer accepts this browser's pairing code. Connect the browser again." }),
        effects: [{ type: "clear" }],
      };
    }
    default:
      return { state, effects: [] };
  }
}

/**
 * What a TenderOS page may learn about the pairing: whether there is one,
 * which code row it is, which server, since when. Never the code.
 * @param {PairingState} state
 * @returns {{ paired: boolean, tokenId: string | null, server: string | null, pairedAt: string | null }}
 */
export function publicPairing(state) {
  if (state.status !== "paired") return { paired: false, tokenId: null, server: null, pairedAt: null };
  let server = null;
  try {
    server = state.server ? new URL(state.server).host : null;
  } catch {
    server = null;
  }
  return { paired: true, tokenId: state.tokenId, server, pairedAt: state.pairedAt };
}
