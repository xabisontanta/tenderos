import { MESSAGE, buildMessage, isTrustedEvent, newNonce, parseExtensionMessage } from "@/extension/src/protocol.js";
import type { PairingInfo, ReadyInfo } from "./connection";

/**
 * The TenderOS page's side of the conversation with the browser helper
 * (window.postMessage; the helper's content script runs on this origin only).
 * Uses the same protocol module as the extension, so the two cannot drift.
 *
 * Rules: messages go to this page's own origin, never "*"; only messages the
 * window posted to itself from this origin that pass the strict schema are
 * believed; a reply counts only if it answers a request still pending (same
 * nonce, matching acknowledgement type). The pairing code is passed through
 * request() once and is not stored anywhere in this object.
 */

export const DETECT_TIMEOUT_MS = 1500;
export const REQUEST_TIMEOUT_MS = 20_000;

export class ExtensionBridgeError extends Error {
  code: string;
  constructor(message: string, code = "error") {
    super(message);
    this.name = "ExtensionBridgeError";
    this.code = code;
  }
}

interface MessageLike {
  source: unknown;
  origin: string;
  data: unknown;
}

/** The parts of `window` the bridge uses (so it can be tested without a browser). */
export interface PageWindow {
  addEventListener(type: "message", listener: (event: MessageLike) => void): void;
  removeEventListener(type: "message", listener: (event: MessageLike) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

export type AckMessage = Record<string, unknown> & { ok: boolean; error?: { code: string; message: string } };
export interface ApplyStatus {
  tenderId: string;
  state: string;
  message: string;
  filled?: number;
  attached?: number;
  left?: number;
}

const ACK_FOR: Record<string, string> = {
  [MESSAGE.PAIR]: MESSAGE.PAIR_ACK,
  [MESSAGE.STATUS]: MESSAGE.STATUS_ACK,
  [MESSAGE.UNPAIR]: MESSAGE.UNPAIR_ACK,
  [MESSAGE.APPLY]: MESSAGE.APPLY_ACK,
};

interface Pending {
  ackType: string;
  resolve: (ack: AckMessage) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ExtensionBridge {
  private readonly pending = new Map<string, Pending>();
  private readonly readyWaiters = new Set<(info: ReadyInfo) => void>();
  private readonly statusListeners = new Set<(status: ApplyStatus) => void>();
  private readonly onMessage = (event: MessageLike) => this.handle(event);

  constructor(
    private readonly win: PageWindow,
    private readonly origin: string,
  ) {
    win.addEventListener("message", this.onMessage);
  }

  dispose(): void {
    this.win.removeEventListener("message", this.onMessage);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.readyWaiters.clear();
    this.statusListeners.clear();
  }

  private handle(event: MessageLike): void {
    if (!isTrustedEvent(event, { win: this.win, origin: this.origin })) return;
    const parsed = parseExtensionMessage(event.data);
    if (!parsed.ok) return;
    const m = parsed.message;
    if (m.type === MESSAGE.READY) {
      const info: ReadyInfo = { extensionVersion: m.extensionVersion, paired: m.paired };
      for (const waiter of [...this.readyWaiters]) waiter(info);
      return;
    }
    if (m.type === MESSAGE.APPLY_STATUS) {
      const { app: _a, v: _v, type: _t, ...status } = m;
      for (const listener of [...this.statusListeners]) listener(status as ApplyStatus);
      return;
    }
    const pending = typeof m.nonce === "string" ? this.pending.get(m.nonce) : undefined;
    if (!pending || pending.ackType !== m.type) return;
    clearTimeout(pending.timer);
    this.pending.delete(m.nonce);
    pending.resolve(m as AckMessage);
  }

  private post(message: Record<string, unknown>): void {
    this.win.postMessage(message, this.origin);
  }

  /** Looks for the helper: resolves with what it announced, or null if nothing answers in time. */
  detect(timeoutMs = DETECT_TIMEOUT_MS): Promise<ReadyInfo | null> {
    return new Promise((resolve) => {
      const waiter = (info: ReadyInfo) => {
        clearTimeout(timer);
        this.readyWaiters.delete(waiter);
        resolve(info);
      };
      const timer = setTimeout(() => {
        this.readyWaiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
      this.readyWaiters.add(waiter);
      this.post(buildMessage(MESSAGE.PING, { nonce: newNonce() }));
    });
  }

  /** Sends a request and resolves with its acknowledgement; rejects if the helper does not answer. */
  request(type: string, fields: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<AckMessage> {
    const ackType = ACK_FOR[type];
    if (!ackType) return Promise.reject(new ExtensionBridgeError("Unknown request.", "bad_request"));
    return new Promise((resolve, reject) => {
      const nonce = newNonce();
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new ExtensionBridgeError("The browser helper did not answer. Check that it is turned on, reload this page and try again.", "timeout"));
      }, timeoutMs);
      this.pending.set(nonce, { ackType, resolve, timer });
      this.post(buildMessage(type, { ...fields, nonce }));
    });
  }

  private async ask(type: string, fields: Record<string, unknown>): Promise<AckMessage> {
    const ack = await this.request(type, fields);
    if (!ack.ok) throw new ExtensionBridgeError(ack.error?.message ?? "The browser helper could not do that.", ack.error?.code ?? "error");
    return ack;
  }

  async status(): Promise<PairingInfo> {
    const ack = await this.ask(MESSAGE.STATUS, {});
    return {
      paired: ack.paired === true,
      tokenId: (ack.tokenId as string | null) ?? null,
      server: (ack.server as string | null) ?? null,
      pairedAt: (ack.pairedAt as string | null) ?? null,
    };
  }

  /** Hands the pairing code straight to the helper. The code is not kept. */
  async pair(token: string, tokenId: string, label: string): Promise<{ organisation: string | null; role: string | null }> {
    const ack = await this.ask(MESSAGE.PAIR, { token, tokenId, ...(label ? { label } : {}) });
    return { organisation: (ack.organisation as string | undefined) ?? null, role: (ack.role as string | undefined) ?? null };
  }

  async unpair(): Promise<void> {
    await this.ask(MESSAGE.UNPAIR, {});
  }

  async apply(tenderId: string, includeSensitive: boolean): Promise<"started" | "needs_toolbar_click"> {
    const ack = await this.ask(MESSAGE.APPLY, { tenderId, includeSensitive });
    return ack.status === "needs_toolbar_click" ? "needs_toolbar_click" : "started";
  }

  onApplyStatus(listener: (status: ApplyStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
}
