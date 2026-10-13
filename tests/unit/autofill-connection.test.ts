import { describe, expect, it } from "vitest";
import { connectionReducer, initialConnection, matchPairing, type ConnectionState } from "@/features/autofill/connection";

const ID = "3f9c2f4e-6a0b-4d6e-9a43-0b7f6f0d2c11";
const READY = { extensionVersion: "0.2.0", paired: false };
const PAIRING = { paired: true, tokenId: ID, server: "tenderos-six.vercel.app", pairedAt: "2026-10-11T08:00:00.000Z" };
const run = (events: Parameters<typeof connectionReducer>[1][], from: ConnectionState = initialConnection) => events.reduce(connectionReducer, from);

describe("connection state machine", () => {
  it("starts by looking for the helper", () => {
    expect(initialConnection.phase).toBe("detecting");
  });

  it("finds the helper unpaired, or already paired", () => {
    expect(run([{ type: "found", info: READY, pairing: { paired: false, tokenId: null, server: null, pairedAt: null } }])).toMatchObject({
      phase: "ready",
      pairing: { paired: false },
    });
    expect(run([{ type: "found", info: { ...READY, paired: true }, pairing: PAIRING }])).toMatchObject({
      phase: "ready",
      pairing: { paired: true, tokenId: ID },
    });
  });

  it("says the helper is missing when nothing answered, and looks again on request", () => {
    const missing = run([{ type: "not_found" }]);
    expect(missing.phase).toBe("missing");
    expect(run([{ type: "recheck" }], missing).phase).toBe("detecting");
  });

  it("goes through connecting to connected, and back to ready on failure with the reason", () => {
    const ready = run([{ type: "found", info: READY, pairing: { paired: false, tokenId: null, server: null, pairedAt: null } }]);
    const connecting = run([{ type: "connect_started" }], ready);
    expect(connecting.phase).toBe("connecting");
    expect(run([{ type: "connected", pairing: PAIRING }], connecting)).toMatchObject({ phase: "ready", pairing: { paired: true, tokenId: ID }, error: null });
    expect(run([{ type: "connect_failed", message: "TenderOS did not accept the pairing code." }], connecting)).toMatchObject({
      phase: "ready",
      pairing: { paired: false },
      error: "TenderOS did not accept the pairing code.",
    });
  });

  it("ignores a second connect while one is running", () => {
    const connecting = run([{ type: "found", info: READY, pairing: PAIRING }, { type: "connect_started" }]);
    expect(run([{ type: "connect_started" }], connecting)).toBe(connecting);
  });

  it("keeps the old pairing when a reconnect fails", () => {
    const paired = run([
      { type: "found", info: { ...READY, paired: true }, pairing: PAIRING },
      { type: "connect_started" },
      { type: "connect_failed", message: "nope" },
    ]);
    expect(paired.pairing).toMatchObject({ paired: true, tokenId: ID });
    expect(paired.error).toBe("nope");
  });

  it("disconnects", () => {
    const paired = run([{ type: "found", info: { ...READY, paired: true }, pairing: PAIRING }]);
    const going = run([{ type: "disconnect_started" }], paired);
    expect(going.phase).toBe("disconnecting");
    expect(run([{ type: "disconnected" }], going)).toMatchObject({ phase: "ready", pairing: { paired: false, tokenId: null }, error: null });
    expect(run([{ type: "disconnect_failed", message: "x" }], going)).toMatchObject({ phase: "ready", pairing: { paired: true }, error: "x" });
  });

  it("does nothing for events that do not apply in the current phase", () => {
    expect(run([{ type: "connected", pairing: PAIRING }])).toBe(initialConnection);
    expect(run([{ type: "disconnected" }])).toBe(initialConnection);
  });

  it("can learn that the helper stopped being paired", () => {
    const paired = run([{ type: "found", info: { ...READY, paired: true }, pairing: PAIRING }]);
    expect(run([{ type: "pairing_changed", pairing: { paired: false, tokenId: null, server: null, pairedAt: null } }], paired).pairing.paired).toBe(false);
  });
});

describe("matchPairing", () => {
  const rows = [
    { id: ID, label: "Office laptop", created_at: "2026-10-01T08:00:00Z", last_used_at: null, expires_at: "2026-10-31T08:00:00Z" },
    { id: "9d5f3a8e-1c0a-4b1f-a7d3-2e8b6f0d9a44", label: "Other", created_at: "2026-09-01T08:00:00Z", last_used_at: null, expires_at: "2026-09-30T08:00:00Z" },
  ];
  const now = new Date("2026-10-11T08:00:00Z").getTime();

  it("finds this browser's code in the member's list", () => {
    expect(matchPairing(PAIRING, rows, now)).toEqual({ kind: "connected", row: rows[0] });
  });

  it("explains an unknown, expired or unlabelled pairing", () => {
    expect(matchPairing({ ...PAIRING, tokenId: "11111111-1111-4111-8111-111111111111" }, rows, now)).toEqual({ kind: "unknown" });
    expect(matchPairing({ ...PAIRING, tokenId: null }, rows, now)).toEqual({ kind: "unknown" });
    expect(matchPairing({ ...PAIRING, tokenId: rows[1].id }, rows, now)).toEqual({ kind: "expired", row: rows[1] });
    expect(matchPairing({ paired: false, tokenId: null, server: null, pairedAt: null }, rows, now)).toEqual({ kind: "none" });
  });
});
