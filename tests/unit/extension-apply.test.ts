import { describe, expect, it, vi } from "vitest";
import { createApplyController, type ApplyDeps, type ApplySession } from "@/extension/src/apply.js";
import { HelperError } from "@/extension/src/errors.js";
import type { FieldDescriptor } from "@/extension/src/match.js";
import type { PanelModel } from "@/extension/src/summary.js";

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TENDER = UUID(1);
const TAX_DOC = UUID(3);
const ORIGIN_TAB = 11;
const PORTAL_TAB = 42;
const SETTINGS = { server: "https://tenderos-six.vercel.app", token: `tos_${"e5".repeat(32)}` };

function rawPlan(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    generated_at: "2026-10-11T08:00:00.000Z",
    organisation: { name: "Acme Trading (Pty) Ltd" },
    member: { role: "admin" },
    tender: {
      id: TENDER,
      title: "Supply of office furniture",
      reference_number: "RFQ 2026/14",
      issuing_organisation: "City of Example",
      closing_at: "2026-10-30T10:00:00.000Z",
    },
    submission_id: UUID(2),
    portal: { url: "https://www.etenders.gov.za/", host: "www.etenders.gov.za" },
    profile: { legal_name: "Acme Trading (Pty) Ltd", csd_number: "MAAA0123456", contact_email: "tenders@acme.co.za" },
    include_sensitive: false,
    documents: [
      {
        id: TAX_DOC,
        doc_type: "tax_compliance",
        title: "TCS PIN letter",
        file_name: "tcs.pdf",
        mime_type: "application/pdf",
        size_bytes: 1200,
        expires_at: "2027-03-31",
        label: "SARS tax compliance",
        sensitive: false,
      },
    ],
    skipped_documents: [],
    ...over,
  };
}

let idx = 0;
const f = (d: Partial<FieldDescriptor>): FieldDescriptor => ({ index: idx++, tag: "input", type: "text", ...d });
const FORM = () => [f({ label: "Registered company name" }), f({ label: "Tax compliance certificate", type: "file" }), f({ label: "Total bid price (R)" })];

interface World {
  deps: ApplyDeps;
  sessions: Map<number, ApplySession>;
  notes: Array<Record<string, unknown>>;
  panels: PanelModel[];
  created: string[];
  injected: number[];
  reports: Array<Record<string, unknown>>;
  fetched: string[];
  state: {
    tabUrl: string | undefined;
    hostAccess: boolean;
    fields: FieldDescriptor[];
    plan: unknown;
    reportError: Error | null;
    docError: Error | null;
    origin: string;
  };
  onUnauthorized: ReturnType<typeof vi.fn>;
}

function world(over: Partial<World["state"]> = {}): World {
  const state: World["state"] = {
    tabUrl: "https://www.etenders.gov.za/Home/Index",
    hostAccess: true,
    fields: FORM(),
    plan: rawPlan(),
    reportError: null,
    docError: null,
    origin: "https://www.etenders.gov.za",
    ...over,
  };
  const sessions = new Map<number, ApplySession>();
  const notes: Array<Record<string, unknown>> = [];
  const panels: PanelModel[] = [];
  const created: string[] = [];
  const injected: number[] = [];
  const reports: Array<Record<string, unknown>> = [];
  const fetched: string[] = [];
  const onUnauthorized = vi.fn(async () => {});
  const deps: ApplyDeps = {
    allowLocalhost: false,
    now: () => new Date("2026-10-11T08:00:00.000Z"),
    todaySast: () => "2026-10-11",
    getSettings: async () => SETTINGS,
    fetchApplyPlan: vi.fn(async () => state.plan),
    fetchDocument: async (_s, id) => {
      fetched.push(id);
      if (state.docError) throw state.docError;
      return { base64: "JVBERg==", size: 4, type: "application/pdf" };
    },
    postApplyReport: async (_s, _id, body) => {
      if (state.reportError) throw state.reportError;
      reports.push(body);
    },
    onUnauthorized,
    tabs: {
      create: async (url) => {
        created.push(url);
        return { id: PORTAL_TAB };
      },
      waitForLoad: async () => ({ url: state.tabUrl }),
      get: async () => ({ id: PORTAL_TAB, url: state.tabUrl }),
    },
    hasHostAccess: async () => state.hostAccess,
    page: {
      inject: async (tabId) => {
        injected.push(tabId);
      },
      scan: async () => [{ frameId: 0, result: { origin: state.origin, fields: state.fields } }],
      applyFrame: async (_tab, _frame, steps) => ({ done: (steps as Array<{ index: number }>).map((s) => s.index), failed: [] }),
      showPanel: async (_tab, model) => {
        panels.push(model);
      },
      hidePanel: async () => {},
    },
    store: {
      get: async (tabId) => sessions.get(tabId) ?? null,
      set: async (tabId, s) => {
        sessions.set(tabId, s);
      },
      remove: async (tabId) => {
        sessions.delete(tabId);
      },
    },
    notify: (tabId, message) => {
      notes.push({ tabId, ...message });
    },
  };
  return { deps, sessions, notes, panels, created, injected, reports, fetched, state, onUnauthorized };
}

const start = (w: World, over: { includeSensitive?: boolean } = {}) =>
  createApplyController(w.deps).start({ tenderId: TENDER, includeSensitive: over.includeSensitive ?? false, originTabId: ORIGIN_TAB });
const lastPanel = (w: World) => w.panels[w.panels.length - 1];
const states = (w: World) => w.notes.map((n) => n.state);

describe("apply: the happy path", () => {
  it("opens the portal, fills, shows the review panel and reports counts", async () => {
    const w = world();
    const r = await start(w);
    expect(r.status).toBe("started");
    await r.finished;

    expect(w.created).toEqual(["https://www.etenders.gov.za/"]);
    expect(w.injected).toContain(PORTAL_TAB);
    expect(w.fetched).toEqual([TAX_DOC]);
    const panel = lastPanel(w);
    expect(panel.mode).toBe("result");
    expect(panel.counts).toEqual({ filled: 1, attached: 1, left: 1 });
    expect(panel.headline).toBe("Prepared 1 field and 1 document for you to review");
    expect(panel.groups.map((g) => g.key)).toEqual(["prices"]);
    expect(panel.reminders.join(" ")).toMatch(/submit/i);
    expect(w.reports).toEqual([{ host: "www.etenders.gov.za", fields: 1, documents: 1, left: 1, sensitive: false, confirmed_host: false }]);
    expect(states(w)).toEqual(["opening", "filling", "prepared"]);
    expect(w.notes.every((n) => n.tabId === ORIGIN_TAB && n.tenderId === TENDER)).toBe(true);
    expect(w.notes[w.notes.length - 1]).toMatchObject({ filled: 1, attached: 1, left: 1 });
    expect(w.sessions.get(PORTAL_TAB)).toMatchObject({ tenderId: TENDER, state: "prepared", mode: "inject", expectedHost: "www.etenders.gov.za" });
  });

  it("never sends field values or file names to TenderOS", async () => {
    const w = world();
    await (
      await start(w)
    ).finished;
    const sent = JSON.stringify(w.reports);
    expect(sent).not.toMatch(/Acme|MAAA|tcs\.pdf|tenders@acme/);
  });

  it("asks for personal documents only when the person ticked the option", async () => {
    const w = world();
    await (
      await start(w, { includeSensitive: true })
    ).finished;
    expect(w.deps.fetchApplyPlan).toHaveBeenCalledWith(SETTINGS, TENDER, true);
    const w2 = world();
    await (
      await start(w2)
    ).finished;
    expect(w2.deps.fetchApplyPlan).toHaveBeenCalledWith(SETTINGS, TENDER, false);
  });

  it("reports what TenderOS says the plan allowed, not what the page asked for", async () => {
    const w = world({ plan: rawPlan({ include_sensitive: false }) });
    await (
      await start(w, { includeSensitive: true })
    ).finished;
    expect(w.reports[0]).toMatchObject({ sensitive: false });
  });
});

describe("apply: refusing before anything is opened", () => {
  it("stops when TenderOS does not accept the code, opening nothing", async () => {
    const w = world();
    vi.mocked(w.deps.fetchApplyPlan).mockRejectedValueOnce(new HelperError("TenderOS did not accept this browser's pairing code.", "unauthorized"));
    await expect(start(w)).rejects.toMatchObject({ code: "unauthorized" });
    expect(w.created).toEqual([]);
    expect(w.onUnauthorized).toHaveBeenCalled();
  });

  it("stops on a plan it cannot trust (not https), opening nothing", async () => {
    const w = world({ plan: rawPlan({ portal: { url: "http://www.etenders.gov.za/", host: "www.etenders.gov.za" } }) });
    await expect(start(w)).rejects.toThrow(/portal address/i);
    expect(w.created).toEqual([]);
  });

  it("passes on the server's message when the bid is no longer waiting for delivery", async () => {
    const w = world();
    vi.mocked(w.deps.fetchApplyPlan).mockRejectedValueOnce(new HelperError("This tender has no approved bid waiting for delivery.", "conflict"));
    await expect(start(w)).rejects.toThrow(/no approved bid/);
    expect(w.created).toEqual([]);
  });

  it("is cautious with localhost portals unless the build allows them", async () => {
    const plan = rawPlan({ portal: { url: "http://localhost:4000/portal", host: "localhost" } });
    const w = world({ plan, tabUrl: "http://localhost:4000/portal", origin: "http://localhost:4000" });
    await expect(start(w)).rejects.toThrow();
    const dev = world({ plan, tabUrl: "http://localhost:4000/portal", origin: "http://localhost:4000" });
    dev.deps.allowLocalhost = true;
    await (
      await start(dev)
    ).finished;
    expect(dev.created).toEqual(["http://localhost:4000/portal"]);
    expect(lastPanel(dev).mode).toBe("result");
  });
});

describe("apply: the portal host is checked before anything is filled", () => {
  it("asks for confirmation, naming both hosts, when the portal sent the tab to another site", async () => {
    const w = world({ tabUrl: "https://login.example.com/start", origin: "https://login.example.com" });
    const r = await start(w);
    await r.finished;
    expect(w.fetched).toEqual([]);
    expect(w.reports).toEqual([]);
    const panel = lastPanel(w);
    expect(panel.mode).toBe("confirm");
    expect(panel.headline).toContain("login.example.com");
    expect(panel.headline).toContain("www.etenders.gov.za");
    expect(states(w)).toContain("confirm_host");
    expect(w.sessions.get(PORTAL_TAB)?.state).toBe("confirm_host");
  });

  it("fills after the person confirms, and says so in the report", async () => {
    const w = world({ tabUrl: "https://login.example.com/start", origin: "https://login.example.com" });
    const c = createApplyController(w.deps);
    await (
      await c.start({ tenderId: TENDER, includeSensitive: false, originTabId: ORIGIN_TAB })
    ).finished;
    await c.onPanelAction(PORTAL_TAB, "confirm");
    expect(w.reports).toEqual([{ host: "login.example.com", fields: 1, documents: 1, left: 1, sensitive: false, confirmed_host: true }]);
    expect(lastPanel(w).mode).toBe("result");
    expect(lastPanel(w).notes.join(" ")).toContain("login.example.com");
  });

  it("drops the session and tells the tender page when the person cancels", async () => {
    const w = world({ tabUrl: "https://login.example.com/start", origin: "https://login.example.com" });
    const c = createApplyController(w.deps);
    await (
      await c.start({ tenderId: TENDER, includeSensitive: false, originTabId: ORIGIN_TAB })
    ).finished;
    await c.onPanelAction(PORTAL_TAB, "cancel");
    expect(w.sessions.has(PORTAL_TAB)).toBe(false);
    expect(states(w)[states(w).length - 1]).toBe("cancelled");
    expect(w.fetched).toEqual([]);
    expect(w.reports).toEqual([]);
  });

  it("does not fill a page that is not https, however it got there", async () => {
    const w = world({ tabUrl: "http://www.etenders.gov.za/", origin: "http://www.etenders.gov.za" });
    await (
      await start(w)
    ).finished;
    expect(w.fetched).toEqual([]);
    expect(w.reports).toEqual([]);
    expect(lastPanel(w).mode).toBe("error");
    expect(states(w)[states(w).length - 1]).toBe("failed");
  });

  it("does not fill a page that navigated to another site between the check and the scan", async () => {
    const w = world();
    w.deps.page.scan = async () => [{ frameId: 0, result: { origin: "https://phish.example.com", fields: FORM() } }];
    await (
      await start(w)
    ).finished;
    expect(w.fetched).toEqual([]);
    expect(w.reports).toEqual([]);
    expect(lastPanel(w).mode).toBe("error");
    expect(lastPanel(w).headline).toMatch(/changed/i);
    expect(states(w)[states(w).length - 1]).toBe("failed");
  });

  it("does not trust a frame of another origin to be the portal", async () => {
    const w = world({ origin: "https://ads.example.com" });
    w.deps.page.scan = async () => [
      { frameId: 0, result: { origin: "https://www.etenders.gov.za", fields: FORM() } },
      { frameId: 9, result: { origin: "https://ads.example.com", fields: [f({ label: "Registered company name" })] } },
    ];
    const applied: number[] = [];
    w.deps.page.applyFrame = async (_t, frameId, steps) => {
      applied.push(frameId);
      return { done: (steps as Array<{ index: number }>).map((s) => s.index), failed: [] };
    };
    await (
      await start(w)
    ).finished;
    expect(applied).toEqual([0]);
  });
});

describe("apply: when it cannot inject", () => {
  it("opens the portal and asks the person to click the toolbar icon", async () => {
    const w = world({ hostAccess: false });
    const r = await start(w);
    await r.finished;
    expect(r.status).toBe("needs_toolbar_click");
    expect(w.created).toEqual(["https://www.etenders.gov.za/"]);
    expect(w.injected).toEqual([]);
    expect(w.fetched).toEqual([]);
    expect(states(w)).toEqual(["opening", "needs_toolbar_click"]);
    expect(w.sessions.get(PORTAL_TAB)).toMatchObject({ mode: "toolbar", state: "needs_toolbar_click" });
  });

  it("fills from the toolbar click, and wants a confirmation when the tab is on another site", async () => {
    const w = world({ hostAccess: false });
    const c = createApplyController(w.deps);
    await (
      await c.start({ tenderId: TENDER, includeSensitive: false, originTabId: ORIGIN_TAB })
    ).finished;

    w.state.tabUrl = "https://other.example.com/form";
    w.state.origin = "https://other.example.com";
    await expect(c.fillSession(PORTAL_TAB, { confirmMismatch: false })).rejects.toThrow(/other\.example\.com.*www\.etenders\.gov\.za/s);
    expect(w.fetched).toEqual([]);

    const summary = await c.fillSession(PORTAL_TAB, { confirmMismatch: true });
    expect(summary.filled).toHaveLength(1);
    expect(w.reports[0]).toMatchObject({ host: "other.example.com", confirmed_host: true });
  });

  it("describes the waiting session to the popup, and nothing for an unknown tab", async () => {
    const w = world({ hostAccess: false });
    const c = createApplyController(w.deps);
    await (
      await c.start({ tenderId: TENDER, includeSensitive: false, originTabId: ORIGIN_TAB })
    ).finished;
    expect(await c.sessionInfo(PORTAL_TAB)).toEqual({
      tenderId: TENDER,
      tender: "Supply of office furniture",
      expectedHost: "www.etenders.gov.za",
      state: "needs_toolbar_click",
      mode: "toolbar",
      includeSensitive: false,
    });
    expect(await c.sessionInfo(999)).toBeNull();
  });
});

describe("apply: what can go wrong while filling", () => {
  it("says there is nothing to fill yet on a sign-in page, and reports nothing", async () => {
    const w = world({ fields: [] });
    await (
      await start(w)
    ).finished;
    expect(lastPanel(w).headline).toMatch(/nothing to fill on this page yet/i);
    expect(lastPanel(w).notes.join(" ")).toMatch(/sign in/i);
    expect(w.reports).toEqual([]);
    expect(states(w)[states(w).length - 1]).toBe("waiting_for_form");
    expect(w.sessions.get(PORTAL_TAB)?.state).toBe("waiting_for_form");
  });

  it("lists a document TenderOS no longer serves and still reports the rest", async () => {
    const w = world({ docError: new HelperError("gone", "not_found") });
    await (
      await start(w)
    ).finished;
    const panel = lastPanel(w);
    expect(panel.counts).toEqual({ filled: 1, attached: 0, left: 2 });
    expect(panel.groups.find((g) => g.key === "documents")?.items[0].reason).toMatch(/no longer available in TenderOS/i);
    expect(w.reports).toHaveLength(1);
  });

  it("stops and clears the pairing when the code is refused mid-fill, reporting nothing", async () => {
    const w = world({ docError: new HelperError("refused", "unauthorized") });
    await (
      await start(w)
    ).finished;
    expect(w.onUnauthorized).toHaveBeenCalled();
    expect(lastPanel(w).mode).toBe("error");
    expect(lastPanel(w).headline).toMatch(/pairing code/i);
    expect(w.reports).toEqual([]);
    expect(states(w)[states(w).length - 1]).toBe("failed");
  });

  it("still shows the result when TenderOS cannot record the report, and says so", async () => {
    const w = world({ reportError: new HelperError("Too many requests", "rate_limited") });
    await (
      await start(w)
    ).finished;
    const panel = lastPanel(w);
    expect(panel.mode).toBe("result");
    expect(panel.notes.join(" ")).toMatch(/could not record this in TenderOS/i);
    expect(states(w)[states(w).length - 1]).toBe("prepared");
  });

  it("does not run two fills on one tab at once", async () => {
    const w = world();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const original = w.deps.page.scan;
    w.deps.page.scan = async (t) => {
      await gate;
      return original(t);
    };
    const c = createApplyController(w.deps);
    const run = await c.start({ tenderId: TENDER, includeSensitive: false, originTabId: ORIGIN_TAB });
    await Promise.resolve();
    await c.onPanelAction(PORTAL_TAB, "refill");
    release();
    await run.finished;
    expect(w.reports).toHaveLength(1);
  });
});

describe("apply: after the first page", () => {
  async function prepared() {
    const w = world();
    const c = createApplyController(w.deps);
    await (
      await c.start({ tenderId: TENDER, includeSensitive: false, originTabId: ORIGIN_TAB })
    ).finished;
    return { w, c };
  }

  it("offers to fill again on later pages of the portal, never filling by itself", async () => {
    const { w, c } = await prepared();
    const before = w.panels.length;
    const fetchedBefore = w.fetched.length;
    await c.onTabLoaded(PORTAL_TAB);
    expect(w.panels.length).toBe(before + 1);
    expect(lastPanel(w).mode).toBe("waiting");
    expect(w.fetched.length).toBe(fetchedBefore);
    expect(w.reports).toHaveLength(1);
  });

  it("fills again when the person presses the button, re-reading the plan from TenderOS", async () => {
    const { w, c } = await prepared();
    await c.onPanelAction(PORTAL_TAB, "refill");
    expect(w.deps.fetchApplyPlan).toHaveBeenCalledTimes(2);
    expect(w.reports).toHaveLength(2);
  });

  it("shows nothing on a page of another site", async () => {
    const { w, c } = await prepared();
    w.state.tabUrl = "https://elsewhere.example.com/";
    const before = w.panels.length;
    await c.onTabLoaded(PORTAL_TAB);
    expect(w.panels.length).toBe(before);
  });

  it("ignores tabs it does not know, forgets closed tabs and expired sessions", async () => {
    const { w, c } = await prepared();
    const before = w.panels.length;
    await c.onTabLoaded(777);
    await c.onPanelAction(777, "refill");
    expect(w.panels.length).toBe(before);

    await c.onTabRemoved(PORTAL_TAB);
    expect(w.sessions.has(PORTAL_TAB)).toBe(false);

    const old = await prepared();
    const s = old.w.sessions.get(PORTAL_TAB)!;
    old.w.sessions.set(PORTAL_TAB, { ...s, startedAt: s.startedAt - 4 * 60 * 60 * 1000 });
    const panelsBefore = old.w.panels.length;
    await old.c.onTabLoaded(PORTAL_TAB);
    expect(old.w.panels.length).toBe(panelsBefore);
    expect(old.w.sessions.has(PORTAL_TAB)).toBe(false);
  });

  it("closing the panel ends the session", async () => {
    const { w, c } = await prepared();
    await c.onPanelAction(PORTAL_TAB, "close");
    expect(w.sessions.has(PORTAL_TAB)).toBe(false);
  });
});
