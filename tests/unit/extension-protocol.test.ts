import { describe, expect, it } from "vitest";
import {
  APPLY_STATES,
  MESSAGE,
  PROTOCOL_VERSION,
  buildMessage,
  isTrustedEvent,
  newNonce,
  parseExtensionMessage,
  parsePageMessage,
} from "@/extension/src/protocol.js";

const TOKEN = `tos_${"a1".repeat(32)}`;
const UUID = "3f9c2f4e-6a0b-4d6e-9a43-0b7f6f0d2c11";
const nonce = () => newNonce();

describe("newNonce", () => {
  it("returns 32 hex characters that do not repeat", () => {
    const seen = new Set(Array.from({ length: 50 }, nonce));
    expect(seen.size).toBe(50);
    for (const n of seen) expect(n).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe("isTrustedEvent", () => {
  const win = { name: "page window" };
  const origin = "https://tenderos-six.vercel.app";

  it("accepts only messages the page window posted to itself from the TenderOS origin", () => {
    expect(isTrustedEvent({ source: win, origin }, { win, origin })).toBe(true);
    expect(isTrustedEvent({ source: {}, origin }, { win, origin })).toBe(false);
    expect(isTrustedEvent({ source: null, origin }, { win, origin })).toBe(false);
    expect(isTrustedEvent({ source: win, origin: "https://evil.example" }, { win, origin })).toBe(false);
    expect(isTrustedEvent({ source: win, origin: "null" }, { win, origin })).toBe(false);
    expect(isTrustedEvent({ source: win, origin: `${origin}.evil.example` }, { win, origin })).toBe(false);
  });
});

describe("page to extension messages", () => {
  const base = { app: "tenderos", v: PROTOCOL_VERSION };

  it("accepts each valid message and returns a clean copy", () => {
    const n = nonce();
    expect(parsePageMessage({ ...base, type: MESSAGE.PING, nonce: n })).toEqual({ ok: true, message: { ...base, type: MESSAGE.PING, nonce: n } });
    expect(parsePageMessage({ ...base, type: MESSAGE.STATUS, nonce: n }).ok).toBe(true);
    expect(parsePageMessage({ ...base, type: MESSAGE.UNPAIR, nonce: n }).ok).toBe(true);
    expect(parsePageMessage({ ...base, type: MESSAGE.PAIR, nonce: n, token: TOKEN, tokenId: UUID, label: "Office laptop" }).ok).toBe(true);
    expect(parsePageMessage({ ...base, type: MESSAGE.PAIR, nonce: n, token: TOKEN }).ok).toBe(true);
    expect(parsePageMessage({ ...base, type: MESSAGE.APPLY, nonce: n, tenderId: UUID, includeSensitive: false }).ok).toBe(true);
  });

  it("rejects anything that is not a plain object of this app and version", () => {
    for (const bad of [null, undefined, "TENDEROS_PING", 42, [], [{ ...base, type: MESSAGE.PING, nonce: nonce() }]]) {
      expect(parsePageMessage(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parsePageMessage({ type: MESSAGE.PING, nonce: nonce() }).ok).toBe(false);
    expect(parsePageMessage({ ...base, app: "other", type: MESSAGE.PING, nonce: nonce() }).ok).toBe(false);
    expect(parsePageMessage({ ...base, v: 2, type: MESSAGE.PING, nonce: nonce() }).ok).toBe(false);
    expect(parsePageMessage({ ...base, v: "1", type: MESSAGE.PING, nonce: nonce() }).ok).toBe(false);
    expect(parsePageMessage({ ...base, type: "TENDEROS_DO_ANYTHING", nonce: nonce() }).ok).toBe(false);
    expect(parsePageMessage(Object.create({ ...base, type: MESSAGE.PING, nonce: nonce() })).ok).toBe(false);
  });

  it("rejects replies and the extension's own message types from a page", () => {
    for (const type of [MESSAGE.READY, MESSAGE.PAIR_ACK, MESSAGE.STATUS_ACK, MESSAGE.UNPAIR_ACK, MESSAGE.APPLY_ACK, MESSAGE.APPLY_STATUS]) {
      expect(parsePageMessage({ ...base, type, nonce: nonce() }).ok, type).toBe(false);
    }
  });

  it("requires a well-formed nonce", () => {
    for (const bad of [undefined, "", "short", "g".repeat(32), "A".repeat(32), "a".repeat(33), 12345, null]) {
      expect(parsePageMessage({ ...base, type: MESSAGE.PING, nonce: bad }).ok, String(bad)).toBe(false);
    }
  });

  it("validates the pairing token, id and label", () => {
    const n = nonce();
    const pair = (extra: Record<string, unknown>) => parsePageMessage({ ...base, type: MESSAGE.PAIR, nonce: n, ...extra });
    expect(pair({}).ok).toBe(false);
    expect(pair({ token: "tos_short" }).ok).toBe(false);
    expect(pair({ token: TOKEN.toUpperCase() }).ok).toBe(false);
    expect(pair({ token: `${TOKEN}x` }).ok).toBe(false);
    expect(pair({ token: TOKEN, tokenId: "not-a-uuid" }).ok).toBe(false);
    expect(pair({ token: TOKEN, label: "x".repeat(61) }).ok).toBe(false);
    expect(pair({ token: TOKEN, label: 5 }).ok).toBe(false);
    // The server address is never taken from the page: the helper uses the origin the message came from.
    expect(pair({ token: TOKEN, server: "https://evil.example" }).ok).toBe(false);
  });

  it("validates the apply request and refuses unknown keys", () => {
    const n = nonce();
    const apply = (extra: Record<string, unknown>) => parsePageMessage({ ...base, type: MESSAGE.APPLY, nonce: n, ...extra });
    expect(apply({ tenderId: UUID, includeSensitive: true }).ok).toBe(true);
    expect(apply({ tenderId: UUID }).ok).toBe(false);
    expect(apply({ tenderId: UUID, includeSensitive: "yes" }).ok).toBe(false);
    expect(apply({ tenderId: "../../etc/passwd", includeSensitive: false }).ok).toBe(false);
    expect(apply({ tenderId: UUID, includeSensitive: false, url: "https://evil.example" }).ok).toBe(false);
    const polluted = JSON.parse(
      `{"app":"tenderos","v":1,"type":"TENDEROS_APPLY","nonce":"${n}","tenderId":"${UUID}","includeSensitive":false,"__proto__":{"x":1}}`,
    );
    expect(parsePageMessage(polluted).ok).toBe(false);
  });

  it("never echoes a token back in a rejection reason", () => {
    const r = parsePageMessage({ ...base, type: MESSAGE.PAIR, nonce: nonce(), token: TOKEN, extra: 1 });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain("a1a1a1a1");
  });
});

describe("extension to page messages", () => {
  const base = { app: "tenderos", v: PROTOCOL_VERSION };

  it("accepts the ready announcement, with or without a reply nonce", () => {
    expect(parseExtensionMessage({ ...base, type: MESSAGE.READY, extensionVersion: "0.2.0", paired: false }).ok).toBe(true);
    expect(parseExtensionMessage({ ...base, type: MESSAGE.READY, extensionVersion: "0.2.0", paired: true, nonce: nonce() }).ok).toBe(true);
    expect(parseExtensionMessage({ ...base, type: MESSAGE.READY, extensionVersion: "<script>", paired: true }).ok).toBe(false);
    expect(parseExtensionMessage({ ...base, type: MESSAGE.READY, paired: true }).ok).toBe(false);
  });

  it("accepts acknowledgements with the nonce they answer", () => {
    const n = nonce();
    expect(parseExtensionMessage({ ...base, type: MESSAGE.PAIR_ACK, nonce: n, ok: true, organisation: "Acme (Pty) Ltd", role: "admin" }).ok).toBe(true);
    expect(
      parseExtensionMessage({ ...base, type: MESSAGE.PAIR_ACK, nonce: n, ok: false, error: { code: "unauthorized", message: "Code not accepted" } }).ok,
    ).toBe(true);
    expect(
      parseExtensionMessage({
        ...base,
        type: MESSAGE.STATUS_ACK,
        nonce: n,
        ok: true,
        paired: true,
        tokenId: UUID,
        server: "tenderos-six.vercel.app",
        pairedAt: "2026-10-11T08:00:00.000Z",
      }).ok,
    ).toBe(true);
    expect(
      parseExtensionMessage({ ...base, type: MESSAGE.STATUS_ACK, nonce: n, ok: true, paired: false, tokenId: null, server: null, pairedAt: null }).ok,
    ).toBe(true);
    expect(parseExtensionMessage({ ...base, type: MESSAGE.UNPAIR_ACK, nonce: n, ok: true }).ok).toBe(true);
    expect(parseExtensionMessage({ ...base, type: MESSAGE.APPLY_ACK, nonce: n, ok: true, status: "started" }).ok).toBe(true);
    expect(parseExtensionMessage({ ...base, type: MESSAGE.APPLY_ACK, nonce: n, ok: true, status: "needs_toolbar_click" }).ok).toBe(true);
    expect(parseExtensionMessage({ ...base, type: MESSAGE.APPLY_ACK, nonce: n, ok: true, status: "sneaky" }).ok).toBe(false);
    expect(parseExtensionMessage({ ...base, type: MESSAGE.PAIR_ACK, ok: true }).ok).toBe(false);
  });

  it("accepts progress updates only with a known state", () => {
    for (const state of APPLY_STATES) {
      expect(parseExtensionMessage({ ...base, type: MESSAGE.APPLY_STATUS, tenderId: UUID, state, message: "Working" }).ok, state).toBe(true);
    }
    expect(
      parseExtensionMessage({ ...base, type: MESSAGE.APPLY_STATUS, tenderId: UUID, state: "prepared", message: "Done", filled: 12, attached: 3, left: 4 }).ok,
    ).toBe(true);
    expect(parseExtensionMessage({ ...base, type: MESSAGE.APPLY_STATUS, tenderId: UUID, state: "exploded", message: "x" }).ok).toBe(false);
    expect(parseExtensionMessage({ ...base, type: MESSAGE.APPLY_STATUS, tenderId: UUID, state: "prepared", message: "x".repeat(400) }).ok).toBe(false);
    expect(parseExtensionMessage({ ...base, type: MESSAGE.APPLY_STATUS, tenderId: UUID, state: "prepared", message: "ok", filled: -1 }).ok).toBe(false);
  });

  it("rejects the page's own request types", () => {
    for (const type of [MESSAGE.PING, MESSAGE.PAIR, MESSAGE.STATUS, MESSAGE.UNPAIR, MESSAGE.APPLY]) {
      expect(parseExtensionMessage({ ...base, type, nonce: nonce() }).ok, type).toBe(false);
    }
  });
});

describe("buildMessage", () => {
  it("adds the app and version, and what it builds the receiver accepts", () => {
    const n = nonce();
    const apply = buildMessage(MESSAGE.APPLY, { nonce: n, tenderId: UUID, includeSensitive: false });
    expect(apply).toMatchObject({ app: "tenderos", v: PROTOCOL_VERSION, type: "TENDEROS_APPLY" });
    expect(parsePageMessage(apply).ok).toBe(true);
    const ack = buildMessage(MESSAGE.APPLY_ACK, { nonce: n, ok: true, status: "started" });
    expect(parseExtensionMessage(ack).ok).toBe(true);
  });

  it("uses the documented type names", () => {
    expect(MESSAGE.READY).toBe("TENDEROS_EXTENSION_READY");
    expect(MESSAGE.PAIR).toBe("TENDEROS_PAIR");
    expect(MESSAGE.APPLY).toBe("TENDEROS_APPLY");
  });
});
