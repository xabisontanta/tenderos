// @ts-check
/**
 * The fill itself, shared by the toolbar button and "Apply with TenderOS".
 * Takes what the content script found on a page, plans with the pure matcher
 * (match.js, whose skip rules are never relaxed here), downloads the
 * documents it needs from TenderOS and hands the plan back to the content
 * script to apply. Talks to the page and to TenderOS only through the deps
 * it is given, so it is unit-tested with fakes (tests/unit/extension-fill.test.ts).
 *
 * It never clicks, submits, ticks, signs or enters a price: the content
 * script refuses anything but text boxes, selects and file uploads.
 */

import { HelperError } from "./errors.js";
import { buildPlan, KEY_LABELS, REASON_TEXT } from "./match.js";

/** Most a single fill hands to a page, in bytes (before base64). */
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

/**
 * @typedef {import("./match.js").FieldDescriptor} FieldDescriptor
 * @typedef {import("./match.js").PlanStep} PlanStep
 * @typedef {{ name: string, type: string, base64: string }} FileEntry
 * @typedef {{ frameId: number, result: { origin?: string, fields: FieldDescriptor[] } | null }} FrameScan
 */

/**
 * @typedef {Object} FillDeps
 * @property {(frameId: number, steps: PlanStep[], files: Record<string, FileEntry>, leftIndexes: number[]) => Promise<{ done: number[], failed: Array<{ index: number, reason: string }> }>} applyFrame
 * @property {(id: string) => Promise<{ base64: string, size: number, type: string }>} fetchDocument
 */

/**
 * @typedef {Object} FillSummary
 * @property {string} page
 * @property {string | null} tender
 * @property {Array<{ label: string, what: string, check: boolean }>} filled
 * @property {Array<{ label: string, files: string[], ids: string[] }>} attached
 * @property {Array<{ label: string, code: string, reason: string }>} left
 * @property {Array<{ label: string, reason: string }>} unattached  Documents the plan wanted to attach that found no upload field.
 * @property {string} at
 */

/**
 * The frames the helper may use: the top frame, and frames on the very same
 * origin as the top frame. A frame from another origin (an ad, a widget, an
 * embedded third-party form) is never read or filled. Without an answer from
 * the top frame nothing is used, because its origin cannot be confirmed.
 * @param {FrameScan[]} scans
 * @returns {FrameScan[]}
 */
export function selectFrames(scans) {
  const top = scans.find((s) => s.frameId === 0 && s.result);
  const origin = top?.result?.origin;
  if (!top || !origin || origin === "null") return [];
  return scans.filter((s) => s.result && (s.frameId === 0 || s.result.origin === origin));
}

/**
 * @param {string} code
 * @returns {string}
 */
const reasonText = (code) => REASON_TEXT[code] ?? REASON_TEXT.unmatched;

/**
 * @typedef {Object} FillInput
 * @property {FrameScan[]} scans
 * @property {FillDeps} deps
 * @property {Record<string, string | number | null>} profile
 * @property {import("./match.js").HelperDocument[]} documents  Documents the helper may attach.
 * @property {import("./match.js").HelperBid | null} bid
 * @property {string} today  YYYY-MM-DD in South Africa.
 * @property {boolean} includeSensitive
 * @property {string} page  Host shown in the summary.
 * @property {Array<{ id: string, label: string }>} [expected]  Documents that should end up attached; any that do not are listed.
 * @property {number} [maxBytes]
 */

/**
 * @param {FillInput} input
 * @returns {Promise<FillSummary>}
 */
export async function runFill(input) {
  const { deps, profile, documents, bid, today, includeSensitive } = input;
  /** @type {FillSummary} */
  const summary = { page: input.page, tender: bid ? bid.tender.title : null, filled: [], attached: [], left: [], unattached: [], at: new Date().toISOString() };
  /** @type {Map<string, FileEntry>} */
  const cache = new Map();
  let budget = input.maxBytes ?? MAX_TOTAL_BYTES;

  /**
   * @param {string} id
   * @returns {Promise<FileEntry>}
   */
  async function file(id) {
    const hit = cache.get(id);
    if (hit) return hit;
    const doc = documents.find((d) => d.id === id);
    if (!doc) throw Object.assign(new Error("missing"), { reason: "no_document" });
    if ((doc.size_bytes ?? 0) > budget) throw Object.assign(new Error("too large"), { reason: "too_large" });
    let data;
    try {
      data = await deps.fetchDocument(id);
    } catch (err) {
      if (err instanceof HelperError && err.code === "unauthorized") throw err;
      const reason =
        err instanceof HelperError && err.code === "not_found"
          ? "doc_revoked"
          : err instanceof HelperError && err.code === "rate_limited"
            ? "rate_limited"
            : "download_failed";
      throw Object.assign(new Error("download"), { reason });
    }
    if (data.size > budget) throw Object.assign(new Error("too large"), { reason: "too_large" });
    budget -= data.size;
    const entry = { name: doc.file_name, type: doc.mime_type || data.type, base64: data.base64 };
    cache.set(id, entry);
    return entry;
  }

  const attachedIds = new Set();
  /** Documents some upload field asked for; if one is not attached, the reason is already in the left list. */
  const attempted = new Set();
  for (const frame of selectFrames(input.scans)) {
    const scan = frame.result;
    if (!scan || !Array.isArray(scan.fields) || !scan.fields.length) continue;
    const plan = buildPlan(scan.fields, { profile, documents, bid, today, includeSensitive });
    const left = [...plan.left];
    /** @type {PlanStep[]} */
    const steps = [];
    /** @type {Record<string, FileEntry>} */
    const files = {};
    for (const step of plan.steps) {
      if (step.action !== "attach") {
        steps.push(step);
        continue;
      }
      /** @type {string[]} */
      const ok = [];
      let reason = "download_failed";
      for (const id of step.documentIds) {
        attempted.add(id);
        try {
          files[id] = await file(id);
          ok.push(id);
        } catch (err) {
          if (err instanceof HelperError) throw err;
          reason = /** @type {{ reason?: string }} */ (err).reason || reason;
        }
      }
      if (ok.length) steps.push({ ...step, documentIds: ok, fileNames: ok.map((id) => /** @type {FileEntry} */ (files[id]).name) });
      else left.push({ index: step.index, label: step.label, reason });
    }

    /** @type {{ done: number[], failed: Array<{ index: number, reason: string }> }} */
    let result = { done: [], failed: steps.map((s) => ({ index: s.index, reason: "changed" })) };
    if (steps.length || left.length) {
      result = await deps.applyFrame(
        frame.frameId,
        steps,
        files,
        left.map((x) => x.index),
      );
    }
    const done = new Set(result.done);
    for (const s of steps) {
      if (done.has(s.index)) {
        if (s.action === "attach") {
          summary.attached.push({ label: s.label, files: s.fileNames, ids: s.documentIds });
          for (const id of s.documentIds) attachedIds.add(id);
        } else summary.filled.push({ label: s.label, what: KEY_LABELS[s.key] ?? s.key, check: s.confidence < 0.75 });
      } else {
        left.push({ index: s.index, label: s.label, reason: result.failed.find((x) => x.index === s.index)?.reason ?? "changed" });
      }
    }
    for (const l of left) {
      const code = l.reason in REASON_TEXT ? l.reason : "unmatched";
      summary.left.push({ label: l.label, code, reason: reasonText(code) });
    }
  }

  for (const e of input.expected ?? []) {
    if (!attachedIds.has(e.id) && !attempted.has(e.id))
      summary.unattached.push({ label: e.label, reason: "No upload field for this document was found on this page." });
  }
  return summary;
}
