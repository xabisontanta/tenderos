// @ts-check
/**
 * Turns the outcome of a fill into the words and numbers people read: the
 * review panel on the portal page, the progress line on the TenderOS tender
 * page and the small report sent back to TenderOS. Pure (no chrome APIs, no
 * DOM); the panel script only draws what these functions return.
 * Unit-tested in tests/unit/extension-summary.test.ts.
 *
 * The report carries the host and counts only: never field values, labels or
 * file names.
 */

/** Things that are always the person's, shown on every review panel. */
export const STANDING_REMINDERS = Object.freeze([
  "You submit. TenderOS never presses Submit, Send or Confirm for you.",
  "Declarations, consents and tick boxes are yours to read and complete.",
  "Prices, rates and the price schedule are yours to enter.",
  "Signatures and initials are yours to sign.",
]);

/**
 * @typedef {Object} PanelAction
 * @property {"refill"|"close"|"confirm"|"cancel"} id
 * @property {string} label
 */

/**
 * @typedef {Object} PanelModel
 * @property {"result"|"confirm"|"waiting"|"error"} mode
 * @property {string} headline
 * @property {string | null} tender
 * @property {string} host
 * @property {{ filled: number, attached: number, left: number } | null} counts
 * @property {Array<{ label: string, what: string, check: boolean }>} filled
 * @property {Array<{ label: string, files: string[] }>} attached
 * @property {Array<{ key: string, title: string, items: Array<{ label: string, reason: string }> }>} groups
 * @property {readonly string[]} reminders
 * @property {string[]} notes
 * @property {PanelAction[]} actions
 */

const GROUPS = /** @type {const} */ ([
  { key: "declarations", title: "Declarations and tick boxes", codes: ["declaration", "choice"] },
  { key: "signatures", title: "Signatures", codes: ["signature"] },
  { key: "prices", title: "Prices and amounts", codes: ["price"] },
  { key: "personal", title: "Personal details and sign-in", codes: ["id_number", "personal", "banking", "password", "captcha", "login"] },
  {
    key: "documents",
    title: "Documents to attach yourself",
    codes: ["no_document", "sensitive", "file_type", "download_failed", "doc_revoked", "too_large", "rate_limited", "unattached"],
  },
  { key: "missing", title: "Not in TenderOS", codes: ["missing", "tender_missing", "no_tender", "expired", "not_mobile"] },
]);
const OTHER_TITLE = "Check these yourself";

/**
 * Sorts what is left for the person into plain categories, in a fixed order.
 * @param {Array<{ label: string, code: string, reason: string }>} left
 * @param {Array<{ label: string, reason: string }>} unattached
 * @returns {Array<{ key: string, title: string, items: Array<{ label: string, reason: string }> }>}
 */
export function groupLeft(left, unattached) {
  const all = [...left, ...unattached.map((u) => ({ label: u.label, code: "unattached", reason: u.reason }))];
  /** @type {Array<{ key: string, title: string, items: Array<{ label: string, reason: string }> }>} */
  const groups = GROUPS.map((g) => ({
    key: /** @type {string} */ (g.key),
    title: /** @type {string} */ (g.title),
    items: all.filter((i) => /** @type {readonly string[]} */ (g.codes).includes(i.code)).map((i) => ({ label: i.label, reason: i.reason })),
  }));
  const known = new Set(GROUPS.flatMap((g) => /** @type {readonly string[]} */ (g.codes)));
  groups.push({ key: "other", title: OTHER_TITLE, items: all.filter((i) => !known.has(i.code)).map((i) => ({ label: i.label, reason: i.reason })) });
  return groups.filter((g) => g.items.length > 0);
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** @param {import("./fill.js").FillSummary} summary */
function distinctDocuments(summary) {
  return new Set(summary.attached.flatMap((a) => a.ids)).size;
}

/**
 * The reasons a bid pack document was left out on purpose, as sentences.
 * @param {Array<{ label: string, reason: string }>} skipped
 * @returns {string[]}
 */
function skippedNotes(skipped) {
  return skipped.map((s) =>
    s.reason === "sensitive_not_requested"
      ? `${s.label} was not attached: you did not tick the option to attach personal documents.`
      : `${s.label} is not available to the helper (it was removed, has expired, is not verified, or is only for owners and admins).`,
  );
}

/**
 * The panel shown once the page has been filled.
 * @param {import("./fill.js").FillSummary} summary
 * @param {{ expectedHost: string, tabHost: string, confirmed?: boolean, skipped?: Array<{ label: string, reason: string }> }} context
 * @returns {PanelModel}
 */
export function buildResultModel(summary, context) {
  const docs = distinctDocuments(summary);
  const filled = summary.filled.length;
  const leftCount = summary.left.length + summary.unattached.length;
  /** @type {string[]} */
  const notes = [];
  if (filled + docs === 0) {
    notes.push("If this is a sign-in or start page, sign in and open the bid form, then press Fill this page again.");
  }
  if (context.confirmed || context.expectedHost !== context.tabHost) {
    if (context.confirmed) notes.push(`You confirmed filling ${context.tabHost}, although TenderOS expected ${context.expectedHost}.`);
  }
  notes.push(...skippedNotes(context.skipped ?? []));
  return {
    mode: "result",
    headline:
      filled + docs === 0
        ? "Nothing to fill on this page yet"
        : `Prepared ${count(filled, "field", "fields")} and ${count(docs, "document", "documents")} for you to review`,
    tender: summary.tender,
    host: summary.page,
    counts: { filled, attached: docs, left: leftCount },
    filled: summary.filled,
    attached: summary.attached.map((a) => ({ label: a.label, files: a.files })),
    groups: groupLeft(summary.left, summary.unattached),
    reminders: STANDING_REMINDERS,
    notes,
    actions: [
      { id: "refill", label: "Fill this page again" },
      { id: "close", label: "Close" },
    ],
  };
}

/**
 * Asks before filling a site other than the portal TenderOS named.
 * @param {{ expectedHost: string, tabHost: string, tender: string | null }} input
 * @returns {PanelModel}
 */
export function buildConfirmModel({ expectedHost, tabHost, tender }) {
  return {
    mode: "confirm",
    headline: `This page is on ${tabHost}, but TenderOS expected ${expectedHost}.`,
    tender,
    host: tabHost,
    counts: null,
    filled: [],
    attached: [],
    groups: [],
    reminders: [],
    notes: [`Only continue if you are sure ${tabHost} is the right portal. Your company details and documents would be entered on this page.`],
    actions: [
      { id: "confirm", label: `Fill on ${tabHost}` },
      { id: "cancel", label: "Cancel" },
    ],
  };
}

/**
 * Shown while the person signs in and finds the form.
 * @param {{ expectedHost: string, tender: string | null }} input
 * @returns {PanelModel}
 */
export function buildWaitingModel({ expectedHost, tender }) {
  return {
    mode: "waiting",
    headline: "Ready when you are",
    tender,
    host: expectedHost,
    counts: null,
    filled: [],
    attached: [],
    groups: [],
    reminders: [],
    notes: ["Sign in to the portal yourself and open the bid form, then press Fill this page. TenderOS never signs in for you."],
    actions: [
      { id: "refill", label: "Fill this page" },
      { id: "close", label: "Close" },
    ],
  };
}

/**
 * @param {string} message What went wrong, in plain words.
 * @param {string} [next] What to do about it.
 * @returns {PanelModel}
 */
export function buildErrorModel(message, next) {
  return {
    mode: "error",
    headline: message,
    tender: null,
    host: "",
    counts: null,
    filled: [],
    attached: [],
    groups: [],
    reminders: [],
    notes: next ? [next] : [],
    actions: [{ id: "close", label: "Close" }],
  };
}

/**
 * What the helper tells TenderOS after a fill: host and counts only.
 * @param {import("./fill.js").FillSummary} summary
 * @param {{ host: string, sensitive: boolean, confirmedHost: boolean }} context
 * @returns {{ host: string, fields: number, documents: number, left: number, sensitive: boolean, confirmed_host: boolean }}
 */
export function reportBody(summary, context) {
  return {
    host: context.host,
    fields: Math.min(summary.filled.length, 500),
    documents: Math.min(distinctDocuments(summary), 30),
    left: Math.min(summary.left.length + summary.unattached.length, 1000),
    sensitive: context.sensitive,
    confirmed_host: context.confirmedHost,
  };
}

/**
 * One sentence for the TenderOS tender page.
 * @param {import("./fill.js").FillSummary} summary
 * @returns {string}
 */
export function statusMessage(summary) {
  const docs = distinctDocuments(summary);
  if (summary.filled.length + docs === 0)
    return `Nothing to fill on ${summary.page} yet. Sign in and open the bid form, then press Fill this page in the panel.`;
  return `Prepared ${count(summary.filled.length, "field", "fields")} and ${count(docs, "document", "documents")} on ${summary.page}. Check everything, then submit it yourself.`;
}
