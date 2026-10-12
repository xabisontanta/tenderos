import { describe, expect, it, vi } from "vitest";
import { createBridge, shouldStartBridge } from "@/extension/src/bridge-main.js";
import { MESSAGE, PROTOCOL_VERSION, buildMessage, newNonce, parseExtensionMessage } from "@/extension/src/protocol.js";

const ORIGIN = "https://tenderos-six.vercel.app";
const TOKEN = `tos_${"f6".repeat(32)}`;
const TOKEN_ID = "3f9c2f4e-6a0b-4d6e-9a43-0b7f6f0d2c11";
const TENDER = "7a1d6c1e-0f0b-4a54-8d59-1b0e1b6e9c11";

type Listener = (event: { source: unknown; origin: string; data: unknown }) => void;

function setup(reply: (message: Record<string, unknown>) => unknown = () => ({ ok: true, data: {} })) {
  const listeners: Listener[] = [];
  const posted: Array<{ message: Record<string, unknown>; target: string }> = [];
  const win = {
    addEventListener: (_t: string, fn: Listener) => listeners.push(fn),
    removeEventListener: () => {},
    postMessage: (message: Record<string, unknown>, target: string) => posted.push({ message, target }),
  };
  const sent: Array<Record<string, unknown>> = [];
  let clock = 1_000;
  const runtime = {
    sendMessage: vi.fn(async (message: Record<string, unknown>) => {
      sent.push(message);
      const r = reply(message);
      if (r instanceof Error) throw r;
      return r;
    }),
  };
  const bridge = createBridge({ win, origin: ORIGIN, runtime, extensionVersion: "0.2.0", now: () => clock });
  bridge.start();
  // The start-up announcement is posted once the (fake) background worker has answered.
  const settled = new Promise((r) => setTimeout(r, 0));
  const send = async (data: unknown, over: Partial<{ source: unknown; origin: string }> = {}) => {
    await settled;
    const before = posted.length;
    for (const l of listeners) l({ source: win, origin: ORIGIN, data, ...over });
    await new Promise((r) => setTimeout(r, 0));
    return posted.slice(before);
  };
  return { bridge, win, posted, sent, runtime, send, tick: (ms: number) => (clock += ms), listeners };
}

const req = (type: string, fields: Record<string, unknown> = {}) => buildMessage(type, { nonce: newNonce(), ...fields });

describe("bridge: presence", () => {
  it("answers a ping with the ready message, echoing the nonce, to the TenderOS origin only", async () => {
    const t = setup((m) =>
      m.action === "status"
        ? { ok: true, data: { paired: true, tokenId: TOKEN_ID, server: "tenderos-six.vercel.app", pairedAt: "2026-10-11T08:00:00.000Z" } }
        : { ok: true },
    );
    const ping = req(MESSAGE.PING);
    const out = await t.send(ping);
    expect(out).toHaveLength(1);
    expect(out[0].target).toBe(ORIGIN);
    expect(out[0].message).toMatchObject({ type: MESSAGE.READY, nonce: ping.nonce, paired: true, extensionVersion: "0.2.0", v: PROTOCOL_VERSION });
    expect(parseExtensionMessage(out[0].message).ok).toBe(true);
  });

  it("announces itself when it starts, without a nonce", async () => {
    const t = setup();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0].message).toMatchObject({ type: MESSAGE.READY, paired: false });
    expect("nonce" in t.posted[0].message).toBe(false);
  });

  it("still announces itself when the background worker does not answer", async () => {
    const t = setup(() => new Error("Extension context invalidated."));
    const out = await t.send(req(MESSAGE.PING));
    expect(out[0].message).toMatchObject({ type: MESSAGE.READY, paired: false });
  });
});

describe("bridge: what it ignores", () => {
  it("ignores messages not posted by the page itself from the TenderOS origin, and malformed ones", async () => {
    const t = setup();
    await new Promise((r) => setTimeout(r, 0));
    const base = t.posted.length;
    const callsBefore = t.runtime.sendMessage.mock.calls.length;
    const good = req(MESSAGE.APPLY, { tenderId: TENDER, includeSensitive: false });
    expect(await t.send(good, { origin: "https://evil.example" })).toEqual([]);
    expect(await t.send(good, { source: {} })).toEqual([]);
    expect(await t.send({ ...good, v: 2 })).toEqual([]);
    expect(await t.send({ ...good, tenderId: "../x" })).toEqual([]);
    expect(await t.send({ ...good, type: MESSAGE.READY })).toEqual([]);
    expect(await t.send("TENDEROS_APPLY")).toEqual([]);
    expect(t.runtime.sendMessage.mock.calls.length).toBe(callsBefore);
    expect(t.posted.length).toBe(base);
  });

  it("drops a burst of messages beyond a sane rate", async () => {
    const t = setup();
    let answered = 0;
    for (let i = 0; i < 40; i++) answered += (await t.send(req(MESSAGE.STATUS))).length;
    expect(answered).toBeLessThanOrEqual(30);
    t.tick(11_000);
    expect((await t.send(req(MESSAGE.STATUS))).length).toBe(1);
  });
});

describe("bridge: pairing", () => {
  it("hands the code straight to the background worker and acknowledges, never echoing the code", async () => {
    const t = setup((m) =>
      m.action === "pair" ? { ok: true, data: { organisation: "Acme (Pty) Ltd", role: "admin" } } : { ok: true, data: { paired: false } },
    );
    const pair = req(MESSAGE.PAIR, { token: TOKEN, tokenId: TOKEN_ID, label: "Office laptop" });
    const out = await t.send(pair);
    expect(t.sent.filter((m) => m.action === "pair")).toEqual([{ source: "bridge", action: "pair", token: TOKEN, tokenId: TOKEN_ID, label: "Office laptop" }]);
    expect(out[0].message).toMatchObject({ type: MESSAGE.PAIR_ACK, nonce: pair.nonce, ok: true, organisation: "Acme (Pty) Ltd", role: "admin" });
    expect(JSON.stringify(t.posted)).not.toContain(TOKEN);
    expect(JSON.stringify(t.posted)).not.toContain("f6f6f6");
  });

  it("passes on why the code was refused, without the code", async () => {
    const t = setup((m) =>
      m.action === "pair" ? { ok: false, error: { code: "unauthorized", message: `TenderOS did not accept ${TOKEN}` } } : { ok: true, data: {} },
    );
    const out = await t.send(req(MESSAGE.PAIR, { token: TOKEN }));
    expect(out[0].message).toMatchObject({ type: MESSAGE.PAIR_ACK, ok: false, error: { code: "unauthorized" } });
    expect(JSON.stringify(t.posted)).not.toContain(TOKEN);
  });

  it("answers status and disconnect", async () => {
    const t = setup((m) => {
      if (m.action === "status")
        return { ok: true, data: { paired: true, tokenId: TOKEN_ID, server: "tenderos-six.vercel.app", pairedAt: "2026-10-11T08:00:00.000Z" } };
      return { ok: true, data: {} };
    });
    const status = req(MESSAGE.STATUS);
    const s = await t.send(status);
    expect(s[0].message).toMatchObject({ type: MESSAGE.STATUS_ACK, nonce: status.nonce, ok: true, paired: true, tokenId: TOKEN_ID });
    const un = req(MESSAGE.UNPAIR);
    const u = await t.send(un);
    expect(t.sent.some((m) => m.action === "unpair")).toBe(true);
    expect(u[0].message).toMatchObject({ type: MESSAGE.UNPAIR_ACK, nonce: un.nonce, ok: true });
  });
});

describe("bridge: apply", () => {
  it("asks the background worker to apply and relays whether it started", async () => {
    const t = setup((m) => (m.action === "apply" ? { ok: true, data: { status: "started" } } : { ok: true, data: {} }));
    const apply = req(MESSAGE.APPLY, { tenderId: TENDER, includeSensitive: true });
    const out = await t.send(apply);
    expect(t.sent.filter((m) => m.action === "apply")).toEqual([{ source: "bridge", action: "apply", tenderId: TENDER, includeSensitive: true }]);
    expect(out[0].message).toMatchObject({ type: MESSAGE.APPLY_ACK, nonce: apply.nonce, ok: true, status: "started" });
  });

  it("relays the toolbar fallback and plain failures", async () => {
    const t = setup((m) => (m.action === "apply" ? { ok: true, data: { status: "needs_toolbar_click" } } : { ok: true, data: {} }));
    expect((await t.send(req(MESSAGE.APPLY, { tenderId: TENDER, includeSensitive: false })))[0].message).toMatchObject({
      ok: true,
      status: "needs_toolbar_click",
    });

    const f = setup((m) =>
      m.action === "apply"
        ? { ok: false, error: { code: "conflict", message: "This tender has no approved bid waiting for delivery." } }
        : { ok: true, data: {} },
    );
    expect((await f.send(req(MESSAGE.APPLY, { tenderId: TENDER, includeSensitive: false })))[0].message).toMatchObject({
      type: MESSAGE.APPLY_ACK,
      ok: false,
      error: { code: "conflict", message: "This tender has no approved bid waiting for delivery." },
    });
  });

  it("says the helper is unavailable when the extension was reloaded under the page", async () => {
    const t = setup((m) => (m.action === "apply" ? new Error("Extension context invalidated.") : { ok: true, data: {} }));
    const out = await t.send(req(MESSAGE.APPLY, { tenderId: TENDER, includeSensitive: false }));
    expect(out[0].message).toMatchObject({ type: MESSAGE.APPLY_ACK, ok: false, error: { code: "extension_unavailable" } });
    expect((out[0].message.error as { message: string }).message).toMatch(/reload this page/i);
  });

  it("never lets a malformed background answer through", async () => {
    const t = setup((m) => (m.action === "apply" ? { ok: true, data: { status: "sneaky", extra: "<script>" } } : { ok: true, data: {} }));
    const out = await t.send(req(MESSAGE.APPLY, { tenderId: TENDER, includeSensitive: false }));
    expect(out[0].message).toMatchObject({ type: MESSAGE.APPLY_ACK, ok: false, error: { code: "bad_reply" } });
    expect(JSON.stringify(out[0].message)).not.toContain("script");
  });
});

describe("bridge: progress from the background worker", () => {
  it("forwards a valid progress update to the page", async () => {
    const t = setup();
    await new Promise((r) => setTimeout(r, 0));
    const before = t.posted.length;
    t.bridge.pushStatus({ tenderId: TENDER, state: "prepared", message: "Prepared 2 fields and 1 document.", filled: 2, attached: 1, left: 3 });
    expect(t.posted.length).toBe(before + 1);
    expect(t.posted[before].target).toBe(ORIGIN);
    expect(t.posted[before].message).toMatchObject({ type: MESSAGE.APPLY_STATUS, tenderId: TENDER, state: "prepared", filled: 2 });
  });

  it("drops an update that does not validate", async () => {
    const t = setup();
    await new Promise((r) => setTimeout(r, 0));
    const before = t.posted.length;
    t.bridge.pushStatus({ tenderId: "nope", state: "prepared", message: "x" });
    t.bridge.pushStatus({ tenderId: TENDER, state: "exploded", message: "x" });
    t.bridge.pushStatus({ tenderId: TENDER, state: "prepared", message: "x", secret: "y" } as never);
    expect(t.posted.length).toBe(before);
  });
});

describe("shouldStartBridge", () => {
  it("runs only in the top frame of the TenderOS origin", () => {
    expect(shouldStartBridge({ origin: ORIGIN, expectedOrigin: ORIGIN, topLevel: true })).toBe(true);
    expect(shouldStartBridge({ origin: ORIGIN, expectedOrigin: ORIGIN, topLevel: false })).toBe(false);
    expect(shouldStartBridge({ origin: "https://evil.example", expectedOrigin: ORIGIN, topLevel: true })).toBe(false);
    expect(shouldStartBridge({ origin: "null", expectedOrigin: ORIGIN, topLevel: true })).toBe(false);
  });
});
