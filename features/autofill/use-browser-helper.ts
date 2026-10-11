"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { connectionReducer, initialConnection, NOT_PAIRED } from "./connection";
import { ExtensionBridge, type PageWindow } from "./extension-bridge";
import { createBrowserPairing, revokeAutofillToken } from "./actions";

/**
 * The browser helper as the TenderOS pages see it: is it installed, is it
 * connected, connect, disconnect. The pairing code goes from the server action
 * to the helper in one step and is never put in React state, the DOM, the
 * clipboard, a URL or a log.
 */
export function useBrowserHelper() {
  const [state, dispatch] = useReducer(connectionReducer, initialConnection);
  const bridgeRef = useRef<ExtensionBridge | null>(null);

  const detect = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    const info = await bridge.detect();
    if (!info) {
      dispatch({ type: "not_found" });
      return;
    }
    let pairing = NOT_PAIRED;
    try {
      pairing = await bridge.status();
    } catch {
      // The helper is there but did not answer a status request; offer to connect.
    }
    dispatch({ type: "found", info, pairing });
  }, []);

  useEffect(() => {
    const bridge = new ExtensionBridge(window as unknown as PageWindow, window.location.origin);
    bridgeRef.current = bridge;
    void detect();
    return () => {
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [detect]);

  const recheck = useCallback(() => {
    dispatch({ type: "recheck" });
    void detect();
  }, [detect]);

  const connect = useCallback(async (label: string): Promise<boolean> => {
    const bridge = bridgeRef.current;
    if (!bridge) return false;
    dispatch({ type: "connect_started" });
    const created = await createBrowserPairing(label);
    if (!created.ok || !created.data) {
      dispatch({ type: "connect_failed", message: created.ok ? "Could not connect the browser." : created.error });
      return false;
    }
    try {
      await bridge.pair(created.data.token, created.data.tokenId, label);
      dispatch({ type: "connected", pairing: await bridge.status() });
      return true;
    } catch (err) {
      // The helper did not take the code: do not leave a live code nobody holds.
      await revokeAutofillToken(created.data.tokenId).catch(() => undefined);
      dispatch({ type: "connect_failed", message: err instanceof Error ? err.message : "Could not connect the browser." });
      return false;
    }
  }, []);

  const disconnect = useCallback(async (tokenId: string | null): Promise<boolean> => {
    const bridge = bridgeRef.current;
    if (!bridge) return false;
    dispatch({ type: "disconnect_started" });
    let helperError: string | null = null;
    try {
      await bridge.unpair();
    } catch (err) {
      helperError = err instanceof Error ? err.message : "The browser helper did not answer.";
    }
    if (tokenId) {
      const revoked = await revokeAutofillToken(tokenId);
      if (!revoked.ok) {
        dispatch({ type: "disconnect_failed", message: revoked.error });
        return false;
      }
    } else if (helperError) {
      dispatch({ type: "disconnect_failed", message: helperError });
      return false;
    }
    dispatch({ type: "disconnected" });
    return true;
  }, []);

  const getBridge = useCallback(() => bridgeRef.current, []);

  return { state, recheck, connect, disconnect, getBridge };
}
