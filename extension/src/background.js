// TenderOS browser helper: background service worker.
//
// The only place the pairing code lives and the only code that talks to
// TenderOS, so the code never enters a web page. Three kinds of sender may
// ask it things, each checked by who they really are (sender.id, sender.tab,
// sender.frameId, sender.url), never by what the message says:
//   - the bridge content script on the TenderOS origin (connect, disconnect,
//     status, "Apply with TenderOS");
//   - the review panel the helper put on a portal tab it opened or was asked
//     to fill (fill again, close, confirm, cancel);
//   - the helper's own popup (toolbar button).
// All real logic is in the pure modules next to this file (pairing.js,
// apply.js, fill.js, hosts.js, ...), which are unit-tested; this file only
// connects them to the chrome APIs. Nothing here clicks, submits, ticks or
// signs anything on a portal.

import { createApplyController } from "./apply.js";
import { DEV_BUILD, TENDEROS_ORIGIN } from "./config.js";
import { HelperError, TOKEN_PATTERN, fetchApplyPlan, fetchDocument, fetchPayload, postApplyReport, verifyPairing } from "./api.js";
import { runFill } from "./fill.js";
import { parsePortalUrl } from "./hosts.js";
import { initialPairing, publicPairing, reducePairing } from "./pairing.js";
import { buildResultModel } from "./summary.js";

// The content scripts never need storage; keep the pairing code out of their reach.
try {
  chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch?.(() => {});
  chrome.storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch?.(() => {});
} catch {
  // Older browsers: content scripts still never read storage.
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PANEL_ACTIONS = new Set(["refill", "close", "confirm", "cancel"]);

// ---------------------------------------------------------------------------
// Pairing: the code lives in chrome.storage.local, in this worker only.
// ---------------------------------------------------------------------------

/** @returns {Promise<{ server: string, token: string, tokenId: string | null, pairedAt: string | null, label: string | null } | null>} */
async function loadStoredPairing() {
  const { pairing, server, token } = await chrome.storage.local.get(["pairing", "server", "token"]);
  if (pairing && typeof pairing === "object" && typeof pairing.token === "string" && TOKEN_PATTERN.test(pairing.token)) return pairing;
  // A code saved by an earlier version of the helper (before one-click pairing).
  if (typeof token === "string" && TOKEN_PATTERN.test(token) && server === TENDEROS_ORIGIN) {
    const migrated = { server: TENDEROS_ORIGIN, token, tokenId: null, pairedAt: null, label: null };
    await chrome.storage.local.set({ pairing: migrated });
    await chrome.storage.local.remove(["server", "token"]);
    return migrated;
  }
  return null;
}

async function currentPairing() {
  return initialPairing(await loadStoredPairing(), TENDEROS_ORIGIN);
}

async function getSettings() {
  const stored = await loadStoredPairing();
  return { server: TENDEROS_ORIGIN, token: stored && stored.server === TENDEROS_ORIGIN ? stored.token : null };
}

/** @param {import("./pairing.js").PairingEffect[]} effects */
async function runPairingEffects(effects) {
  for (const e of effects) {
    if (e.type === "store") await chrome.storage.local.set({ pairing: e.record });
    if (e.type === "clear") await chrome.storage.local.remove(["pairing", "server", "token"]);
  }
}

let pairingInFlight = false;

/**
 * Pairs with a code a TenderOS page (or the popup) handed over. The server is
 * always this build's TenderOS origin; the code is checked with TenderOS
 * before it is kept.
 * @param {{ token: string, tokenId?: string | null, label?: string | null }} request
 */
async function pair({ token, tokenId = null, label = null }) {
  if (pairingInFlight) throw new HelperError("Another connection is being checked. Try again in a moment.");
  pairingInFlight = true;
  try {
    const state = await currentPairing();
    const start = reducePairing(
      state,
      { type: "pair_requested", origin: TENDEROS_ORIGIN, token, tokenId, label, now: new Date().toISOString() },
      TENDEROS_ORIGIN,
    );
    if (start.rejected) throw new HelperError(start.state.error?.message ?? "Could not connect.", "forbidden");
    let who;
    try {
      who = await verifyPairing(TENDEROS_ORIGIN, token);
    } catch (err) {
      reducePairing(
        start.state,
        { type: "verify_failed", error: { code: err instanceof HelperError ? (err.code ?? "error") : "error", message: String(err?.message ?? err) } },
        TENDEROS_ORIGIN,
      );
      throw err;
    }
    const done = reducePairing(start.state, { type: "verified", token, organisation: who.organisation, role: who.role }, TENDEROS_ORIGIN);
    await runPairingEffects(done.effects);
    return { organisation: who.organisation, role: who.role };
  } finally {
    pairingInFlight = false;
  }
}

async function unpair() {
  const r = reducePairing(await currentPairing(), { type: "unpair_requested" }, TENDEROS_ORIGIN);
  await runPairingEffects(r.effects);
}

/** TenderOS stopped accepting the code (revoked or expired): forget it. */
async function forgetRejectedPairing() {
  const r = reducePairing(await currentPairing(), { type: "token_rejected" }, TENDEROS_ORIGIN);
  await runPairingEffects(r.effects);
}

// ---------------------------------------------------------------------------
// Keeping the worker alive while a fill runs (service workers sleep when idle).
// ---------------------------------------------------------------------------

let jobs = 0;
let keepAliveTimer = null;
function withKeepAlive(promise) {
  jobs += 1;
  if (!keepAliveTimer) keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
  const done = () => {
    jobs -= 1;
    if (jobs <= 0 && keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      jobs = 0;
    }
  };
  promise.then(done, done);
  return promise;
}

// ---------------------------------------------------------------------------
// Apply with TenderOS: the controller with the real browser behind it.
// ---------------------------------------------------------------------------

function todaySast() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

const sessionKey = (tabId) => `apply:${tabId}`;

async function setBadge(tabId, text) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1d4ed8" });
  } catch {
    // The tab may be gone.
  }
}

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(value);
    };
    const check = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete" && !/^(about:|chrome:\/\/newtab)/.test(tab.url || tab.pendingUrl || "")) finish({ url: tab.url });
      } catch {
        finish(null);
      }
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") check();
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    check();
  });
}

const controller = createApplyController({
  allowLocalhost: DEV_BUILD,
  now: () => new Date(),
  todaySast,
  getSettings,
  fetchApplyPlan,
  fetchDocument,
  postApplyReport,
  onUnauthorized: forgetRejectedPairing,
  tabs: {
    create: async (url) => {
      const tab = await chrome.tabs.create({ url, active: true });
      return { id: /** @type {number} */ (tab.id) };
    },
    waitForLoad,
    get: async (tabId) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        return { id: tabId, url: tab.url };
      } catch {
        return null;
      }
    },
  },
  hasHostAccess: async (origin) => {
    try {
      return await chrome.permissions.contains({ origins: [`${origin}/*`] });
    } catch {
      return false;
    }
  },
  page: {
    inject: async (tabId) => {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["src/content.js"] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["src/panel.js"] });
    },
    scan: async (tabId) => {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => (globalThis.__tenderosHelper ? globalThis.__tenderosHelper.scan() : null),
      });
      return results.map((r) => ({ frameId: r.frameId, result: r.result ?? null }));
    },
    applyFrame: async (tabId, frameId, steps, files, leftIndexes) => {
      const [applied] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: (s, f, l) => globalThis.__tenderosHelper.apply(s, f, l),
        args: [steps, files, leftIndexes],
      });
      return applied?.result ?? { done: [], failed: steps.map((s) => ({ index: s.index, reason: "changed" })) };
    },
    showPanel: async (tabId, model) => {
      await chrome.scripting.executeScript({ target: { tabId }, func: (m) => globalThis.__tenderosPanel?.show(m), args: [model] });
    },
    hidePanel: async (tabId) => {
      await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__tenderosPanel?.hide() });
    },
  },
  store: {
    get: async (tabId) => (await chrome.storage.session.get(sessionKey(tabId)))[sessionKey(tabId)] ?? null,
    set: async (tabId, session) => {
      await chrome.storage.session.set({ [sessionKey(tabId)]: session });
      await setBadge(tabId, session.state === "needs_toolbar_click" ? "1" : "");
    },
    remove: async (tabId) => {
      await chrome.storage.session.remove(sessionKey(tabId));
      await setBadge(tabId, "");
    },
  },
  notify: (originTabId, message) => {
    chrome.tabs.sendMessage(originTabId, { source: "background", kind: "apply_status", ...message }).catch(() => {});
  },
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete") controller.onTabLoaded(tabId).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  controller.onTabRemoved(tabId).catch(() => {});
});

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

/** @returns {"popup" | "bridge" | "page" | null} */
function senderKind(sender) {
  if (sender.id !== chrome.runtime.id) return null;
  const url = String(sender.url || "");
  if (!sender.tab) return url.startsWith(chrome.runtime.getURL("popup/")) ? "popup" : null;
  if (sender.frameId !== 0) return null;
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  return origin === TENDEROS_ORIGIN ? "bridge" : "page";
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const kind = senderKind(sender);
  const wanted = message && typeof message === "object" ? message.source : null;
  // Each kind of sender may only speak as itself.
  const expectedKind = wanted === "popup" ? "popup" : wanted === "bridge" ? "bridge" : wanted === "panel" ? "page" : null;
  if (!kind || kind !== expectedKind) return false;

  /** @type {Promise<unknown>} */
  let work;
  if (wanted === "bridge") work = handleBridge(message, sender);
  else if (wanted === "panel") work = handlePanel(message, sender);
  else work = handlePopup(message);

  work.then(
    (data) => sendResponse({ ok: true, data }),
    (err) =>
      sendResponse({
        ok: false,
        error: {
          code: err instanceof HelperError ? (err.code ?? "error") : "error",
          message: err instanceof HelperError ? err.message : `Something went wrong: ${err?.message ?? err}`,
        },
      }),
  );
  return true;
});

async function handleBridge(message, sender) {
  switch (message.action) {
    case "status":
      return publicPairing(await currentPairing());
    case "pair":
      if (typeof message.token !== "string" || !TOKEN_PATTERN.test(message.token)) throw new HelperError("That is not a TenderOS pairing code.");
      return pair({
        token: message.token,
        tokenId: typeof message.tokenId === "string" && UUID_PATTERN.test(message.tokenId) ? message.tokenId : null,
        label: typeof message.label === "string" ? message.label.slice(0, 60) : null,
      });
    case "unpair":
      await unpair();
      return {};
    case "apply": {
      if (typeof message.tenderId !== "string" || !UUID_PATTERN.test(message.tenderId) || typeof message.includeSensitive !== "boolean") {
        throw new HelperError("That request was not understood.");
      }
      const started = await controller.start({
        tenderId: message.tenderId,
        includeSensitive: message.includeSensitive,
        originTabId: /** @type {number} */ (sender.tab.id),
      });
      withKeepAlive(started.finished).catch(() => {});
      return { status: started.status };
    }
    default:
      throw new HelperError("Unknown request.");
  }
}

async function handlePanel(message, sender) {
  const action = String(message.action);
  if (!PANEL_ACTIONS.has(action)) throw new HelperError("Unknown request.");
  await withKeepAlive(controller.onPanelAction(/** @type {number} */ (sender.tab.id), action));
  return {};
}

async function handlePopup(message) {
  switch (message?.action) {
    case "state": {
      const pairing = publicPairing(await currentPairing());
      const session = Number.isInteger(message.tabId) ? await controller.sessionInfo(message.tabId) : null;
      return { pairing, session, origin: TENDEROS_ORIGIN };
    }
    case "load":
      return fetchPayload(await getSettings());
    case "pair":
      if (typeof message.token !== "string" || !TOKEN_PATTERN.test(message.token))
        throw new HelperError("Paste the whole pairing code. It starts with tos_ and is 68 characters long.");
      return pair({ token: message.token, label: "Pasted code" });
    case "forget":
      await unpair();
      return {};
    case "fill":
      return withKeepAlive(fillActiveTab(Number(message.tabId), message.submissionId ? String(message.submissionId) : null, Boolean(message.includeSensitive)));
    case "session_fill":
      return withKeepAlive(controller.fillSession(Number(message.tabId), { confirmMismatch: Boolean(message.confirmMismatch) }));
    default:
      throw new HelperError("Unknown request.");
  }
}

// ---------------------------------------------------------------------------
// The toolbar button: fill the tab the person is looking at.
// ---------------------------------------------------------------------------

async function fillActiveTab(tabId, submissionId, includeSensitiveRequested) {
  const tab = await chrome.tabs.get(tabId);
  const page = parsePortalUrl(tab.url, { allowLocalhost: DEV_BUILD });
  if (!page.ok) throw new HelperError("The helper only fills secure (https) web pages. Open the tender portal's form in this tab, then click Fill this page.");
  if (page.origin === TENDEROS_ORIGIN) throw new HelperError("This is TenderOS itself. Open the tender portal's form, then fill it.");
  const settings = await getSettings();

  let payload;
  try {
    payload = await fetchPayload(settings);
  } catch (err) {
    if (err instanceof HelperError && err.code === "unauthorized") await forgetRejectedPairing();
    throw err;
  }
  const bid = submissionId ? (payload.bids.find((b) => b.submission_id === submissionId) ?? null) : null;
  if (submissionId && !bid) throw new HelperError("That bid is no longer waiting for delivery. Close and reopen the helper.");
  const includeSensitive = includeSensitiveRequested && (payload.member?.role === "owner" || payload.member?.role === "admin");

  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["src/content.js"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/panel.js"] });
  } catch (err) {
    throw new HelperError(
      `The helper cannot work on this page (${err?.message ?? "access denied"}). Click the helper icon on the portal page itself, then try again.`,
    );
  }
  const scans = (
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (globalThis.__tenderosHelper ? globalThis.__tenderosHelper.scan() : null),
    })
  ).map((r) => ({ frameId: r.frameId, result: r.result ?? null }));

  let summary;
  try {
    summary = await runFill({
      scans,
      deps: {
        applyFrame: async (frameId, steps, files, leftIndexes) => {
          const [applied] = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            func: (s, f, l) => globalThis.__tenderosHelper.apply(s, f, l),
            args: [steps, files, leftIndexes],
          });
          return applied?.result ?? { done: [], failed: steps.map((s) => ({ index: s.index, reason: "changed" })) };
        },
        fetchDocument: (id) => fetchDocument(settings, id),
      },
      profile: payload.profile,
      documents: payload.documents,
      bid,
      today: todaySast(),
      includeSensitive,
      page: page.host,
    });
  } catch (err) {
    if (err instanceof HelperError && err.code === "unauthorized") await forgetRejectedPairing();
    throw err;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (m) => globalThis.__tenderosPanel?.show(m),
      args: [buildResultModel(summary, { expectedHost: page.host, tabHost: page.host })],
    });
  } catch {
    // The popup still shows the summary.
  }
  try {
    await chrome.storage.session.set({ lastSummary: { tabId, url: page.origin + new URL(tab.url).pathname, summary } });
  } catch {
    // Session storage is a convenience for reopening the popup; the summary is returned either way.
  }
  return summary;
}
