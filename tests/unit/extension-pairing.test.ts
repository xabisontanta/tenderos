import { describe, expect, it } from "vitest";
import { initialPairing, publicPairing, reducePairing, type PairingState } from "@/extension/src/pairing.js";

const ORIGIN = "https://tenderos-six.vercel.app";
const TOKEN = `tos_${"b2".repeat(32)}`;
const TOKEN_ID = "3f9c2f4e-6a0b-4d6e-9a43-0b7f6f0d2c11";
const NOW = "2026-10-11T08:00:00.000Z";

const request = (extra: Record<string, unknown> = {}) => ({
  type: "pair_requested" as const,
  origin: ORIGIN,
  token: TOKEN,
  tokenId: TOKEN_ID,
  label: "Office laptop",
  now: NOW,
  ...extra,
});

describe("pairing state machine", () => {
  it("starts unpaired, or paired from what was saved", () => {
    expect(initialPairing(null, ORIGIN).status).toBe("unpaired");
    expect(initialPairing({ server: "https://other.example", token: TOKEN, tokenId: null, pairedAt: NOW, label: "x" }, ORIGIN).status).toBe("unpaired");
    const paired = initialPairing({ server: ORIGIN, token: TOKEN, tokenId: TOKEN_ID, pairedAt: NOW, label: "Office laptop" }, ORIGIN);
    expect(paired).toMatchObject({ status: "paired", server: ORIGIN, tokenId: TOKEN_ID, pairedAt: NOW });
  });

  it("verifies a code before it keeps it, then stores it", () => {
    const s0 = initialPairing(null, ORIGIN);
    const r1 = reducePairing(s0, request(), ORIGIN);
    expect(r1.state.status).toBe("pairing");
    expect(r1.effects).toEqual([{ type: "verify", server: ORIGIN, token: TOKEN }]);

    const r2 = reducePairing(r1.state, { type: "verified", token: TOKEN, organisation: "Acme (Pty) Ltd", role: "admin" }, ORIGIN);
    expect(r2.state).toMatchObject({
      status: "paired",
      server: ORIGIN,
      tokenId: TOKEN_ID,
      label: "Office laptop",
      organisation: "Acme (Pty) Ltd",
      role: "admin",
      pairedAt: NOW,
    });
    expect(r2.effects).toEqual([{ type: "store", record: { server: ORIGIN, token: TOKEN, tokenId: TOKEN_ID, pairedAt: NOW, label: "Office laptop" } }]);
  });

  it("stores nothing and stays unpaired when TenderOS does not accept the code", () => {
    const r1 = reducePairing(initialPairing(null, ORIGIN), request(), ORIGIN);
    const r2 = reducePairing(
      r1.state,
      { type: "verify_failed", error: { code: "unauthorized", message: "TenderOS did not accept the pairing code." } },
      ORIGIN,
    );
    expect(r2.state).toMatchObject({ status: "unpaired", error: { code: "unauthorized" } });
    expect(r2.effects).toEqual([]);
  });

  it("keeps an existing pairing when a replacement code fails", () => {
    const paired = initialPairing({ server: ORIGIN, token: TOKEN, tokenId: TOKEN_ID, pairedAt: "2026-09-01T00:00:00.000Z", label: "Old" }, ORIGIN);
    const r1 = reducePairing(paired, request({ token: `tos_${"c3".repeat(32)}`, tokenId: null, label: "New" }), ORIGIN);
    expect(r1.state.status).toBe("pairing");
    const r2 = reducePairing(r1.state, { type: "verify_failed", error: { code: "network", message: "Could not reach TenderOS." } }, ORIGIN);
    expect(r2.state).toMatchObject({ status: "paired", tokenId: TOKEN_ID, label: "Old" });
    expect(r2.effects).toEqual([]);
  });

  it("only pairs with the origin the helper was built for, never one the page names", () => {
    const r = reducePairing(initialPairing(null, ORIGIN), request({ origin: "https://evil.example" }), ORIGIN);
    expect(r.state.status).toBe("unpaired");
    expect(r.state).toMatchObject({ error: { code: "wrong_origin" } });
    expect(r.effects).toEqual([]);
  });

  it("refuses a second pairing while one is being checked", () => {
    const r1 = reducePairing(initialPairing(null, ORIGIN), request(), ORIGIN);
    const r2 = reducePairing(r1.state, request(), ORIGIN);
    expect(r2.state.status).toBe("pairing");
    expect(r2.effects).toEqual([]);
    expect(r2.rejected).toBe("busy");
  });

  it("forgets the code on disconnect and when TenderOS rejects it later", () => {
    const paired = initialPairing({ server: ORIGIN, token: TOKEN, tokenId: TOKEN_ID, pairedAt: NOW, label: "x" }, ORIGIN);
    const gone = reducePairing(paired, { type: "unpair_requested" }, ORIGIN);
    expect(gone.state.status).toBe("unpaired");
    expect(gone.effects).toEqual([{ type: "clear" }]);

    const rejected = reducePairing(paired, { type: "token_rejected" }, ORIGIN);
    expect(rejected.state).toMatchObject({ status: "unpaired", error: { code: "unauthorized" } });
    expect(rejected.effects).toEqual([{ type: "clear" }]);

    // Disconnecting when nothing is paired is harmless.
    expect(reducePairing(initialPairing(null, ORIGIN), { type: "unpair_requested" }, ORIGIN).state.status).toBe("unpaired");
  });

  it("never holds the code in its state or in what it shows to pages", () => {
    const r1 = reducePairing(initialPairing(null, ORIGIN), request(), ORIGIN);
    const r2 = reducePairing(r1.state, { type: "verified", token: TOKEN, organisation: "Acme", role: "owner" }, ORIGIN);
    for (const s of [r1.state, r2.state]) {
      expect(JSON.stringify(s)).not.toContain(TOKEN);
      expect(JSON.stringify(s)).not.toContain("b2b2b2");
      expect(JSON.stringify(publicPairing(s))).not.toContain("b2b2b2");
    }
    expect(publicPairing(r2.state as PairingState)).toEqual({ paired: true, tokenId: TOKEN_ID, server: "tenderos-six.vercel.app", pairedAt: NOW });
    expect(publicPairing(initialPairing(null, ORIGIN))).toEqual({ paired: false, tokenId: null, server: null, pairedAt: null });
  });
});
