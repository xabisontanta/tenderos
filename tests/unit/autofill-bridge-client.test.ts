import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DETECT_TIMEOUT_MS, ExtensionBridge, ExtensionBridgeError } from "@/features/autofill/extension-bridge";
import { MESSAGE, PROTOCOL_VERSION, buildMessage } from "@/extension/src/protocol.js";

const ORIGIN = "https://tenderos-six.vercel.app";
const TOKEN = `tos_${"a7".repeat(32)}`;
const TENDER = "7a1d6c1e-0f0b-4a54-8d59-1b0e1b6e9c11";

type Listener = (event: { source: unknown; origin: string; data: unknown }) => void;

function fakeWindow() {
  const listeners = new Set<Listener>();
  const sent: Array<{ message: Record<string, unknown>; target: string }> = [];
  const win = {
    addEventListener: (_t: "message", fn: Listener) => listeners.add(fn),
    removeEventListener: (_t: "message", fn: Listener) => listeners.delete(fn),
    postMessage: (message: unknown, target: string) => sent.push({ message: message as Record<string, unknown>, target }),
  };
  const deliver = (data: unknown, over: Partial<{ source: unknown; origin: string }> = {}) => {
    for (const l of [...listeners]) l({ source: win, origin: ORIGIN, data, ...over });
  };
  return { win, sent, deliver, listeners };
}

const ready = (extra: Record<string, unknown> = {}) => buildMessage(MESSAGE.READY, { extensionVersion: "0.2.0", paired: false, ...extra });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ExtensionBridge.detect", () => {
  it("pings the page's own origin and resolves when the helper announces itself", async () => {
    const f = fakeWindow();
    const bridge = new ExtensionBridge(f.win, ORIGIN);
    const found = bridge.detect();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].target).toBe(ORIGIN);
    expect(f.sent[0].message).toMatchObject({ app: "tenderos", v: PROTOCOL_VERSION, type: MESSAGE.PING });
    f.deliver(ready({ nonce: f.sent[0].message.nonce, paired: true }));
    await expect(found).resolves.toEqual({ extensionVersion: "0.2.0", paired: true });
  });

  it("resolves null when nothing answers within about a second and a half", async () => {
    const f = fakeWindow();
    const found = new ExtensionBridge(f.win, ORIGIN).detect();
    await vi.advanceTimersByTimeAsync(DETECT_TIMEOUT_MS - 1);
    let settled = false;
    void found.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(found).resolves.toBeNull();
    expect(DETECT_TIMEOUT_MS).toBe(1500);
  });

  it("accepts an announcement that was made before the ping", async () => {
    const f = fakeWindow();
    const bridge = new ExtensionBridge(f.win, ORIGIN);
    const found = bridge.detect();
    f.deliver(ready());
    await expect(found).resolves.toMatchObject({ extensionVersion: "0.2.0" });
  });

  it("ignores announcements from other windows or origins and malformed ones", async () => {
    const f = fakeWindow();
    const found = new ExtensionBridge(f.win, ORIGIN).detect();
    f.deliver(ready(), { source: {} });
    f.deliver(ready(), { origin: "https://evil.example" });
    f.deliver({ ...ready(), extensionVersion: "<script>" });
    f.deliver("TENDEROS_EXTENSION_READY");
    await vi.advanceTimersByTimeAsync(DETECT_TIMEOUT_MS + 1);
    await expect(found).resolves.toBeNull();
  });
});

describe("ExtensionBridge.request", () => {
  it("sends a versioned message with a fresh nonce and resolves with the matching acknowledgement", async () => {
    const f = fakeWindow();
    const bridge = new ExtensionBridge(f.win, ORIGIN);
    const answer = bridge.request(MESSAGE.APPLY, { tenderId: TENDER, includeSensitive: false });
    const out = f.sent[0];
    expect(out.target).toBe(ORIGIN);
    expect(out.message).toMatchObject({ type: MESSAGE.APPLY, tenderId: TENDER, includeSensitive: false });
    expect(out.message.nonce).toMatch(/^[a-f0-9]{32}$/);
    f.deliver(buildMessage(MESSAGE.APPLY_ACK, { nonce: out.message.nonce, ok: true, status: "started" }));
    await expect(answer).resolves.toMatchObject({ type: MESSAGE.APPLY_ACK, ok: true, status: "started" });
  });

  it("uses a different nonce for each request", () => {
    const f = fakeWindow();
    const bridge = new ExtensionBridge(f.win, ORIGIN);
    void bridge.request(MESSAGE.STATUS, {}).catch(() => {});
    void bridge.request(MESSAGE.STATUS, {}).catch(() => {});
    expect(f.sent[0].message.nonce).not.toBe(f.sent[1].message.nonce);
  });

  it("ignores replies with the wrong nonce, the wrong type or from an untrusted sender", async () => {
    const f = fakeWindow();
    const bridge = new ExtensionBridge(f.win, ORIGIN);
    const answer = bridge.request(MESSAGE.APPLY, { tenderId: TENDER, includeSensitive: false });
    const nonce = f.sent[0].message.nonce;
    f.deliver(buildMessage(MESSAGE.APPLY_ACK, { nonce: "0".repeat(32), ok: true, status: "started" }));
    f.deliver(buildMessage(MESSAGE.PAIR_ACK, { nonce, ok: true }));
    f.deliver(buildMessage(MESSAGE.APPLY_ACK, { nonce, ok: true, status: "started" }), { origin: "https://evil.example" });
    f.deliver(buildMessage(MESSAGE.APPLY_ACK, { nonce, ok: true, status: "started" }), { source: {} });
    let settled = false;
    void answer.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    f.deliver(buildMessage(MESSAGE.APPLY_ACK, { nonce, ok: true, status: "started" }));
    await expect(answer).resolves.toMatchObject({ ok: true });
  });

  it("answers each request only once", async () => {
    const f = fakeWindow();
    const bridge = new ExtensionBridge(f.win, ORIGIN);
    const answer = bridge.request(MESSAGE.UNPAIR, {});
    const nonce = f.sent[0].message.nonce;
    f.deliver(buildMessage(MESSAGE.UNPAIR_ACK, { nonce, ok: true }));
    await answer;
    expect(() => f.deliver(buildMessage(MESSAGE.UNPAIR_ACK, { nonce, ok: false, error: { code: "x", message: "late" } }))).not.toThrow();
  });

  it("rejects with a plain message when the helper does not answer in time", async () => {
    const f = fakeWindow();
    const bridge = new ExtensionBridge(f.win, ORIGIN);
    const answer = bridge.request(MESSAGE.STATUS, {}, 5000);
    const assertion = expect(answer).rejects.toBeInstanceOf(ExtensionBridgeError);
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    await expect(answer).rejects.toThrow(/did not answer/i);
  });

  it("never keeps a pairing code after sending it", async () => {
    const f = fakeWindow();
    const bridge = new ExtensionBridge(f.win, ORIGIN);
    const answer = bridge.request(MESSAGE.PAIR, { token: TOKEN, tokenId: TENDER, label: "Office laptop" });
    f.deliver(buildMessage(MESSAGE.PAIR_ACK, { nonce: f.sent[0].message.nonce, ok: true, organisation: "Acme" }));
    const ack = await answer;
    expect(JSON.stringify(ack)).not.toContain(TOKEN);
    expect(JSON.stringify(bridge)).not.toContain(TOKEN);
  });
});

describe("ExtensionBridge progress updates", () => {
  it("passes valid updates from the helper to listeners and stops after unsubscribe", () => {
    const f = fakeWindow();
    const bridge = new ExtensionBridge(f.win, ORIGIN);
    const seen: unknown[] = [];
    const off = bridge.onApplyStatus((s) => seen.push(s));
    f.deliver(buildMessage(MESSAGE.APPLY_STATUS, { tenderId: TENDER, state: "prepared", message: "Prepared 2 fields", filled: 2 }));
    f.deliver(buildMessage(MESSAGE.APPLY_STATUS, { tenderId: TENDER, state: "exploded", message: "x" }), {});
    f.deliver(buildMessage(MESSAGE.APPLY_STATUS, { tenderId: TENDER, state: "failed", message: "x" }), { origin: "https://evil.example" });
    expect(seen).toEqual([expect.objectContaining({ tenderId: TENDER, state: "prepared", filled: 2 })]);
    off();
    f.deliver(buildMessage(MESSAGE.APPLY_STATUS, { tenderId: TENDER, state: "failed", message: "later" }));
    expect(seen).toHaveLength(1);
  });

  it("stops listening when disposed", () => {
    const f = fakeWindow();
    const bridge = new ExtensionBridge(f.win, ORIGIN);
    expect(f.listeners.size).toBe(1);
    bridge.dispose();
    expect(f.listeners.size).toBe(0);
  });
});
