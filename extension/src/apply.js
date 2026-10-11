// @ts-check
/**
 * "Apply with TenderOS": open the portal in a new tab, check the page is on
 * the portal TenderOS named, fill what can be matched, attach the approved
 * bid pack documents and show the review panel. The person still submits.
 *
 * Everything browser-specific (tabs, scripting, storage, permissions, the
 * network) is injected through `deps`, so the whole flow is unit-tested with
 * in-memory fakes (tests/unit/extension-apply.test.ts). background.js wires
 * the real chrome APIs.
 *
 * Rules this module enforces:
 *  - the plan must validate (https portal, no unrequested personal documents)
 *    before any tab is opened;
 *  - nothing is filled unless the tab's site (registrable domain) is the
 *    portal's, or the person confirmed a different site with both hosts named;
 *  - only the top frame and same-origin frames are used (fill.js);
 *  - a fill happens only at the person's click or as the very first fill
 *    after they pressed Apply; later pages of the portal get a button, never
 *    an automatic fill;
 *  - the report sent to TenderOS has the host and counts only.
 */

import { HelperError } from "./errors.js";
import { runFill } from "./fill.js";
import { evaluateTarget, parsePortalUrl } from "./hosts.js";
import { parseApplyPlan } from "./plan.js";
import { buildConfirmModel, buildErrorModel, buildResultModel, buildWaitingModel, reportBody, statusMessage } from "./summary.js";

/** How long a portal tab stays an apply session. */
export const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
/** How long to wait for the portal to finish loading. */
export const LOAD_TIMEOUT_MS = 45_000;

/**
 * @typedef {Object} ApplySession
 * @property {string} tenderId
 * @property {string} tender  Tender title, for the panel.
 * @property {boolean} includeSensitive  What the person asked for; TenderOS decides what the plan contains.
 * @property {number} originTabId  The TenderOS tab to report progress to.
 * @property {string} expectedHost
 * @property {string} portalOrigin
 * @property {"inject"|"toolbar"} mode  inject: the helper may act on the portal tab itself; toolbar: the person clicks the toolbar icon.
 * @property {"opening"|"waiting_for_form"|"confirm_host"|"filling"|"prepared"|"needs_toolbar_click"|"failed"} state
 * @property {boolean} confirmedHost  The person confirmed filling a site other than the expected one.
 * @property {number} startedAt  Milliseconds since the epoch.
 */

/**
 * @typedef {Object} ApplyDeps
 * @property {boolean} allowLocalhost
 * @property {() => Date} now
 * @property {() => string} todaySast
 * @property {() => Promise<{ server: string, token: string | null }>} getSettings
 * @property {(settings: { server: string, token: string | null }, tenderId: string, includeSensitive: boolean) => Promise<unknown>} fetchApplyPlan
 * @property {(settings: { server: string, token: string | null }, id: string) => Promise<{ base64: string, size: number, type: string }>} fetchDocument
 * @property {(settings: { server: string, token: string | null }, tenderId: string, body: ReturnType<typeof reportBody>) => Promise<void>} postApplyReport
 * @property {() => Promise<void>} onUnauthorized  Called when TenderOS stops accepting the pairing code.
 * @property {{ create: (url: string) => Promise<{ id: number }>, waitForLoad: (tabId: number, timeoutMs: number) => Promise<{ url?: string } | null>, get: (tabId: number) => Promise<{ id: number, url?: string } | null> }} tabs
 * @property {(origin: string) => Promise<boolean>} hasHostAccess  Whether the helper holds host access to the portal without the person's click.
 * @property {{
 *   inject: (tabId: number) => Promise<void>,
 *   scan: (tabId: number) => Promise<import("./fill.js").FrameScan[]>,
 *   applyFrame: import("./fill.js").FillDeps["applyFrame"] extends (...a: infer A) => infer R ? (tabId: number, ...a: A) => R : never,
 *   showPanel: (tabId: number, model: import("./summary.js").PanelModel) => Promise<void>,
 *   hidePanel: (tabId: number) => Promise<void>,
 * }} page
 * @property {{ get: (tabId: number) => Promise<ApplySession | null>, set: (tabId: number, s: ApplySession) => Promise<void>, remove: (tabId: number) => Promise<void> }} store
 * @property {(originTabId: number, message: { tenderId: string, state: string, message: string, filled?: number, attached?: number, left?: number }) => void} notify
 */

/** @param {string} text @param {number} [max] */
const clip = (text, max = 290) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * @param {ApplyDeps} deps
 */
export function createApplyController(deps) {
  /** Tabs with a fill or check in progress. */
  const running = new Set();

  /**
   * @template T
   * @param {number} tabId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T | null>}  null when this tab is already busy
   */
  function guarded(tabId, fn) {
    if (running.has(tabId)) return Promise.resolve(null);
    running.add(tabId);
    return fn().finally(() => running.delete(tabId));
  }

  /** @param {ApplySession} s */
  const expired = (s) => deps.now().getTime() - s.startedAt > SESSION_TTL_MS;

  /**
   * @param {number} tabId
   * @returns {Promise<ApplySession | null>}
   */
  async function liveSession(tabId) {
    const s = await deps.store.get(tabId);
    if (!s) return null;
    if (expired(s)) {
      await deps.store.remove(tabId);
      return null;
    }
    return s;
  }

  /**
   * @param {ApplySession} session
   * @param {string} state
   * @param {string} message
   * @param {{ filled?: number, attached?: number, left?: number }} [counts]
   */
  function tell(session, state, message, counts = {}) {
    try {
      deps.notify(session.originTabId, { tenderId: session.tenderId, state, message: clip(message), ...counts });
    } catch {
      // The TenderOS tab may be gone; the panel on the portal still shows everything.
    }
  }

  /**
   * @param {number} tabId
   * @param {ApplySession} session
   * @param {ApplySession["state"]} state
   */
  async function setState(tabId, session, state) {
    session.state = state;
    await deps.store.set(tabId, session);
  }

  /**
   * Shows an error on the portal page (if the helper can) and on the tender page.
   * @param {number} tabId
   * @param {ApplySession} session
   * @param {string} message
   * @param {string} [next]
   */
  async function fail(tabId, session, message, next) {
    try {
      await deps.page.inject(tabId);
      await deps.page.showPanel(tabId, buildErrorModel(message, next));
    } catch {
      // Not allowed to draw on this page; the tender page still gets the message.
    }
    tell(session, "failed", next ? `${message} ${next}` : message);
    await setState(tabId, session, "failed");
  }

  /**
   * The check-then-fill step. Returns the summary when it filled.
   * @param {number} tabId
   * @param {ApplySession} session
   * @param {{ plan?: import("./plan.js").ApplyPlan, tabUrl?: string }} [options]
   */
  async function prepare(tabId, session, options = {}) {
    const tab = await deps.tabs.get(tabId);
    if (!tab) {
      await deps.store.remove(tabId);
      return null;
    }
    const decision = evaluateTarget({ expectedHost: session.expectedHost, tabUrl: options.tabUrl ?? tab.url, allowLocalhost: deps.allowLocalhost });
    if (decision.decision === "refuse") {
      await fail(tabId, session, decision.message, "Open the portal's own https page and press Fill this page again.");
      return null;
    }
    if (decision.decision === "confirm" && !session.confirmedHost) {
      try {
        await deps.page.inject(tabId);
        await deps.page.showPanel(tabId, buildConfirmModel({ expectedHost: decision.expectedHost, tabHost: decision.tabHost, tender: session.tender }));
      } catch (err) {
        await fail(
          tabId,
          session,
          `The helper cannot work on this page (${/** @type {Error} */ (err)?.message ?? "access denied"}).`,
          "Click the helper icon on the portal page itself, then try again.",
        );
        return null;
      }
      tell(session, "confirm_host", `This tab is on ${decision.tabHost}, not ${decision.expectedHost}. Confirm on that page to continue, or cancel.`);
      await setState(tabId, session, "confirm_host");
      return null;
    }
    return fill(tabId, session, options.plan);
  }

  /**
   * @param {number} tabId
   * @param {ApplySession} session
   * @param {import("./plan.js").ApplyPlan} [knownPlan]
   */
  async function fill(tabId, session, knownPlan) {
    const tab = await deps.tabs.get(tabId);
    const page = tab?.url ? parsePortalUrl(tab.url, { allowLocalhost: deps.allowLocalhost }) : null;
    if (!page || !page.ok) {
      await fail(
        tabId,
        session,
        "The helper cannot read this page's address, so it will not fill it.",
        "Open the portal's own https page and press Fill this page again.",
      );
      return null;
    }
    try {
      const settings = await deps.getSettings();
      const plan =
        knownPlan ?? parseApplyPlan(await deps.fetchApplyPlan(settings, session.tenderId, session.includeSensitive), { allowLocalhost: deps.allowLocalhost });
      if (plan.tender.id !== session.tenderId || plan.portal.host !== session.expectedHost) {
        throw new HelperError(
          "TenderOS sent a plan for a different tender or portal than this session was started for. Start again from the tender page.",
          "invalid_response",
        );
      }
      tell(session, "filling", `Filling the form on ${page.host}. Nothing will be submitted.`);
      await setState(tabId, session, "filling");
      try {
        await deps.page.inject(tabId);
      } catch (err) {
        throw new HelperError(
          `The helper cannot work on this page (${/** @type {Error} */ (err)?.message ?? "access denied"}). Click the helper icon on the portal page itself, then try again.`,
        );
      }
      const scans = await deps.page.scan(tabId);
      const summary = await runFill({
        scans,
        deps: {
          applyFrame: (frameId, steps, files, leftIndexes) => deps.page.applyFrame(tabId, frameId, steps, files, leftIndexes),
          fetchDocument: (id) => deps.fetchDocument(settings, id),
        },
        profile: plan.profile,
        documents: plan.documents,
        bid: plan.bid,
        today: deps.todaySast(),
        includeSensitive: plan.includeSensitive,
        page: page.host,
        expected: plan.documents.map((d) => ({ id: d.id, label: d.label })),
      });

      const model = buildResultModel(summary, {
        expectedHost: session.expectedHost,
        tabHost: page.host,
        confirmed: session.confirmedHost,
        skipped: plan.skipped,
      });
      await deps.page.showPanel(tabId, model);
      const counts = { filled: model.counts?.filled ?? 0, attached: model.counts?.attached ?? 0, left: model.counts?.left ?? 0 };
      if (counts.filled + counts.attached === 0) {
        tell(session, "waiting_for_form", statusMessage(summary), counts);
        await setState(tabId, session, "waiting_for_form");
        return summary;
      }
      try {
        await deps.postApplyReport(
          settings,
          session.tenderId,
          reportBody(summary, { host: page.host, sensitive: plan.includeSensitive, confirmedHost: session.confirmedHost }),
        );
      } catch (err) {
        if (err instanceof HelperError && err.code === "unauthorized") await deps.onUnauthorized();
        model.notes.push("The helper could not record this in TenderOS (the tender page will not show it). The form on this page is still filled.");
        await deps.page.showPanel(tabId, model);
      }
      tell(session, "prepared", statusMessage(summary), counts);
      await setState(tabId, session, "prepared");
      return summary;
    } catch (err) {
      if (err instanceof HelperError && err.code === "unauthorized") {
        await deps.onUnauthorized();
        await fail(
          tabId,
          session,
          "TenderOS no longer accepts this browser's pairing code.",
          "Connect the browser again in TenderOS, Settings, Browser helper.",
        );
      } else if (err instanceof HelperError) {
        await fail(tabId, session, err.message);
      } else {
        await fail(
          tabId,
          session,
          `Something went wrong while filling: ${/** @type {Error} */ (err)?.message ?? err}`,
          "Press Fill this page again, or fill the form yourself.",
        );
      }
      return null;
    }
  }

  return {
    /**
     * Starts "Apply with TenderOS" for one tender. Rejects (before opening any
     * tab) when the plan cannot be had or cannot be trusted.
     * @param {{ tenderId: string, includeSensitive: boolean, originTabId: number }} request
     * @returns {Promise<{ status: "started" | "needs_toolbar_click", finished: Promise<void> }>}
     */
    async start({ tenderId, includeSensitive, originTabId }) {
      const settings = await deps.getSettings();
      let plan;
      try {
        plan = parseApplyPlan(await deps.fetchApplyPlan(settings, tenderId, includeSensitive), { allowLocalhost: deps.allowLocalhost });
      } catch (err) {
        if (err instanceof HelperError && err.code === "unauthorized") await deps.onUnauthorized();
        throw err;
      }
      if (plan.tender.id !== tenderId) throw new HelperError("TenderOS sent a plan for a different tender. Try again.", "invalid_response");

      /** @type {ApplySession} */
      const session = {
        tenderId,
        tender: plan.tender.title,
        includeSensitive,
        originTabId,
        expectedHost: plan.portal.host,
        portalOrigin: plan.portal.origin,
        mode: "inject",
        state: "opening",
        confirmedHost: false,
        startedAt: deps.now().getTime(),
      };
      const notice = { tenderId, state: "opening", message: `Opening ${plan.portal.host} in a new tab.` };
      deps.notify(originTabId, notice);
      const tab = await deps.tabs.create(plan.portal.url);

      if (!(await deps.hasHostAccess(plan.portal.origin))) {
        session.mode = "toolbar";
        session.state = "needs_toolbar_click";
        await deps.store.set(tab.id, session);
        tell(
          session,
          "needs_toolbar_click",
          `TenderOS opened ${plan.portal.host}. Click the TenderOS icon in your browser toolbar, then press Fill this page.`,
        );
        return { status: "needs_toolbar_click", finished: Promise.resolve() };
      }

      await deps.store.set(tab.id, session);
      const finished = guarded(tab.id, async () => {
        const loaded = await deps.tabs.waitForLoad(tab.id, LOAD_TIMEOUT_MS);
        if (!loaded) {
          tell(session, "waiting_for_form", `${plan.portal.host} is still loading. The helper will offer to fill it when the page has opened.`);
          await setState(tab.id, session, "waiting_for_form");
          return;
        }
        await prepare(tab.id, session, { plan, tabUrl: loaded.url });
      }).then(() => undefined);
      return { status: "started", finished };
    },

    /**
     * The person pressed a button on the review panel.
     * @param {number} tabId
     * @param {string} action
     */
    async onPanelAction(tabId, action) {
      const session = await liveSession(tabId);
      if (!session || session.mode !== "inject") return;
      if (action === "close") {
        await deps.page.hidePanel(tabId).catch(() => {});
        await deps.store.remove(tabId);
      } else if (action === "cancel") {
        await deps.page.hidePanel(tabId).catch(() => {});
        await deps.store.remove(tabId);
        tell(session, "cancelled", "You cancelled. Nothing was filled.");
      } else if (action === "confirm") {
        if (session.state !== "confirm_host") return;
        session.confirmedHost = true;
        await guarded(tabId, () => fill(tabId, session));
      } else if (action === "refill") {
        await guarded(tabId, () => prepare(tabId, session));
      }
    },

    /**
     * A page of a portal tab finished loading: offer to fill it (never fills by itself).
     * @param {number} tabId
     */
    async onTabLoaded(tabId) {
      const session = await liveSession(tabId);
      if (!session || session.mode !== "inject" || running.has(tabId)) return;
      if (session.state === "opening" || session.state === "confirm_host" || session.state === "filling") return;
      await guarded(tabId, async () => {
        const tab = await deps.tabs.get(tabId);
        if (!tab) return;
        if (evaluateTarget({ expectedHost: session.expectedHost, tabUrl: tab.url, allowLocalhost: deps.allowLocalhost }).decision !== "match") return;
        try {
          await deps.page.inject(tabId);
          await deps.page.showPanel(tabId, buildWaitingModel({ expectedHost: session.expectedHost, tender: session.tender }));
        } catch {
          // Not allowed to draw on this page: nothing to offer.
        }
      });
    },

    /** @param {number} tabId */
    async onTabRemoved(tabId) {
      await deps.store.remove(tabId);
    },

    /**
     * The person clicked the toolbar icon on a tab with a waiting session and chose to fill it.
     * @param {number} tabId
     * @param {{ confirmMismatch: boolean }} options
     * @returns {Promise<import("./fill.js").FillSummary>}
     */
    async fillSession(tabId, { confirmMismatch }) {
      const session = await liveSession(tabId);
      if (!session) throw new HelperError("There is nothing waiting for this tab. Press Apply with TenderOS on the tender page.");
      const tab = await deps.tabs.get(tabId);
      const decision = evaluateTarget({ expectedHost: session.expectedHost, tabUrl: tab?.url, allowLocalhost: deps.allowLocalhost });
      if (decision.decision === "refuse") throw new HelperError(decision.message);
      if (decision.decision === "confirm") {
        if (!confirmMismatch) {
          throw new HelperError(
            `This tab is on ${decision.tabHost}, but TenderOS expected ${decision.expectedHost}. Confirm that it is the right portal to continue.`,
          );
        }
        session.confirmedHost = true;
      }
      const summary = await guarded(tabId, () => fill(tabId, session));
      if (!summary) throw new HelperError("The helper could not fill this page. See the message on the page or the tender, then try again.");
      return summary;
    },

    /**
     * What the popup shows for a tab: the waiting apply session, if any.
     * @param {number} tabId
     */
    async sessionInfo(tabId) {
      const s = await liveSession(tabId);
      if (!s) return null;
      return { tenderId: s.tenderId, tender: s.tender, expectedHost: s.expectedHost, state: s.state, mode: s.mode, includeSensitive: s.includeSensitive };
    },
  };
}
