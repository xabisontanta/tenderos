/**
 * The page's view of the browser helper as a small state machine: looking for
 * it, not installed, found (paired or not), connecting, disconnecting. Pure,
 * unit-tested in tests/unit/autofill-connection.test.ts. The pairing code
 * never appears here: the helper reports only whether it is paired and which
 * code row it holds.
 */

export interface ReadyInfo {
  extensionVersion: string;
  paired: boolean;
}

export interface PairingInfo {
  paired: boolean;
  tokenId: string | null;
  server: string | null;
  pairedAt: string | null;
}

export const NOT_PAIRED: PairingInfo = { paired: false, tokenId: null, server: null, pairedAt: null };

export type ConnectionPhase = "detecting" | "missing" | "ready" | "connecting" | "disconnecting";

export interface ConnectionState {
  phase: ConnectionPhase;
  extension: ReadyInfo | null;
  pairing: PairingInfo;
  error: string | null;
}

export type ConnectionEvent =
  | { type: "found"; info: ReadyInfo; pairing: PairingInfo }
  | { type: "not_found" }
  | { type: "recheck" }
  | { type: "connect_started" }
  | { type: "connected"; pairing: PairingInfo }
  | { type: "connect_failed"; message: string }
  | { type: "disconnect_started" }
  | { type: "disconnected" }
  | { type: "disconnect_failed"; message: string }
  | { type: "pairing_changed"; pairing: PairingInfo };

export const initialConnection: ConnectionState = { phase: "detecting", extension: null, pairing: NOT_PAIRED, error: null };

export function connectionReducer(state: ConnectionState, event: ConnectionEvent): ConnectionState {
  switch (event.type) {
    case "found":
      if (state.phase === "connecting" || state.phase === "disconnecting") return state;
      return { phase: "ready", extension: event.info, pairing: event.pairing, error: null };
    case "not_found":
      return state.phase === "detecting" ? { ...state, phase: "missing", extension: null } : state;
    case "recheck":
      return state.phase === "missing" || state.phase === "ready" ? { ...state, phase: "detecting", error: null } : state;
    case "connect_started":
      return state.phase === "ready" ? { ...state, phase: "connecting", error: null } : state;
    case "connected":
      return state.phase === "connecting" ? { ...state, phase: "ready", pairing: event.pairing, error: null } : state;
    case "connect_failed":
      return state.phase === "connecting" ? { ...state, phase: "ready", error: event.message } : state;
    case "disconnect_started":
      return state.phase === "ready" ? { ...state, phase: "disconnecting", error: null } : state;
    case "disconnected":
      return state.phase === "disconnecting" ? { ...state, phase: "ready", pairing: NOT_PAIRED, error: null } : state;
    case "disconnect_failed":
      return state.phase === "disconnecting" ? { ...state, phase: "ready", error: event.message } : state;
    case "pairing_changed":
      return state.phase === "ready" ? { ...state, pairing: event.pairing } : state;
    default:
      return state;
  }
}

export interface PairingRow {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
}

/** Which of the member's pairing codes is the one this browser's helper holds. */
export function matchPairing(
  pairing: PairingInfo,
  rows: PairingRow[],
  now: number,
): { kind: "none" } | { kind: "unknown" } | { kind: "expired"; row: PairingRow } | { kind: "connected"; row: PairingRow } {
  if (!pairing.paired) return { kind: "none" };
  const row = pairing.tokenId ? rows.find((r) => r.id === pairing.tokenId) : undefined;
  if (!row) return { kind: "unknown" };
  return new Date(row.expires_at).getTime() <= now ? { kind: "expired", row } : { kind: "connected", row };
}
