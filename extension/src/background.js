// TenderOS browser helper: background service worker.
//
// Does every request to TenderOS, so the pairing code never enters a web
// page. When the person clicks "Fill this page" it injects the content
// script into that tab, asks it which fields exist, plans the fill with the
// pure matcher (match.js) and hands the content script the plan and the
// files. Nothing here clicks, submits, ticks or signs.

import { buildPlan, KEY_LABELS, REASON_TEXT } from "./match.js";
import { fetchDocument, fetchPayload, getSettings, HelperError } from "./api.js";

/** Most a single fill hands to a page, in bytes (before base64). */
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

// The content script never needs storage; keep the pairing code out of its reach.
try {
  chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch?.(() => {});
} catch {
  // Older browsers: content scripts still never read storage.
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the helper's own popup may ask. Content scripts (and so web pages) cannot.
  if (sender.id !== chrome.runtime.id || sender.tab || !String(sender.url || "").startsWith(chrome.runtime.getURL("popup/"))) return false;
  handle(message).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: err instanceof HelperError ? err.message : `Something went wrong: ${err?.message ?? err}` }),
  );
  return true;
});

async function handle(message) {
  switch (message?.type) {
    case "load":
      return fetchPayload(await getSettings());
    case "fill":
      return fillTab(Number(message.tabId), message.submissionId ? String(message.submissionId) : null, Boolean(message.includeSensitive));
    default:
      throw new HelperError("Unknown request.");
  }
}

function todaySast() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function fillTab(tabId, submissionId, includeSensitiveRequested) {
  const tab = await chrome.tabs.get(tabId);
  let url;
  try {
    url = new URL(tab.url || "");
  } catch {
    throw new HelperError("Open the tender portal's form in this tab, then click Fill this page.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HelperError("The helper only fills web pages (http or https).");
  const settings = await getSettings();
  if (new URL(settings.server).origin === url.origin) throw new HelperError("This is TenderOS itself. Open the tender portal's form, then fill it.");

  const payload = await fetchPayload(settings);
  const bid = submissionId ? (payload.bids.find((b) => b.submission_id === submissionId) ?? null) : null;
  if (submissionId && !bid) throw new HelperError("That bid is no longer waiting for delivery. Close and reopen the helper.");
  const includeSensitive = includeSensitiveRequested && (payload.member?.role === "owner" || payload.member?.role === "admin");

  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["src/content.js"] });
  } catch (err) {
    throw new HelperError(
      `The helper cannot work on this page (${err?.message ?? "access denied"}). Click the helper icon on the portal page itself, then try again.`,
    );
  }
  const scans = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => (globalThis.__tenderosHelper ? globalThis.__tenderosHelper.scan() : null),
  });

  const today = todaySast();
  const summary = { page: url.host, tender: bid ? bid.tender.title : null, filled: [], attached: [], left: [], at: new Date().toISOString() };
  const cache = new Map();
  let budget = MAX_TOTAL_BYTES;

  async function file(id) {
    if (cache.has(id)) return cache.get(id);
    const doc = payload.documents.find((d) => d.id === id);
    if (!doc) throw Object.assign(new Error("missing"), { reason: "no_document" });
    if ((doc.size_bytes ?? 0) > budget) throw Object.assign(new Error("too large"), { reason: "too_large" });
    let data;
    try {
      data = await fetchDocument(settings, id);
    } catch {
      throw Object.assign(new Error("download"), { reason: "download_failed" });
    }
    if (data.size > budget) throw Object.assign(new Error("too large"), { reason: "too_large" });
    budget -= data.size;
    const entry = { name: doc.file_name, type: doc.mime_type || data.type, base64: data.base64 };
    cache.set(id, entry);
    return entry;
  }

  for (const frame of scans) {
    const scan = frame.result;
    if (!scan || !Array.isArray(scan.fields) || !scan.fields.length) continue;
    const plan = buildPlan(scan.fields, { profile: payload.profile, documents: payload.documents, bid, today, includeSensitive });
    const left = [...plan.left];
    const steps = [];
    const files = {};
    for (const step of plan.steps) {
      if (step.action !== "attach") {
        steps.push(step);
        continue;
      }
      const ok = [];
      let reason = "download_failed";
      for (const id of step.documentIds) {
        try {
          files[id] = await file(id);
          ok.push(id);
        } catch (err) {
          reason = err.reason || reason;
        }
      }
      if (ok.length) steps.push({ ...step, documentIds: ok, fileNames: ok.map((id) => files[id].name) });
      else left.push({ index: step.index, label: step.label, reason });
    }

    let result = { done: [], failed: steps.map((s) => ({ index: s.index, reason: "changed" })) };
    if (steps.length || left.length) {
      const [applied] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        func: (s, f, l) => globalThis.__tenderosHelper.apply(s, f, l),
        args: [steps, files, left.map((x) => x.index)],
      });
      if (applied?.result) result = applied.result;
    }
    const done = new Set(result.done);
    for (const s of steps) {
      if (done.has(s.index)) {
        if (s.action === "attach") summary.attached.push({ label: s.label, files: s.fileNames });
        else summary.filled.push({ label: s.label, what: KEY_LABELS[s.key] ?? s.key, check: s.confidence < 0.75 });
      } else {
        left.push({ index: s.index, label: s.label, reason: result.failed.find((x) => x.index === s.index)?.reason ?? "changed" });
      }
    }
    for (const l of left) summary.left.push({ label: l.label, reason: REASON_TEXT[l.reason] ?? REASON_TEXT.unmatched });
  }

  try {
    await chrome.storage.session.set({ lastSummary: { tabId, url: url.origin + url.pathname, summary } });
  } catch {
    // Session storage is a convenience for reopening the popup; the summary is returned either way.
  }
  return summary;
}
