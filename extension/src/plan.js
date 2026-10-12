// @ts-check
/**
 * Reads the plan TenderOS sends for "Apply with TenderOS"
 * (GET /api/autofill/tenders/<id>/apply-plan). Pure: no chrome APIs, no DOM.
 * Unit-tested in tests/unit/extension-plan.test.ts, and against what the
 * server builds in tests/unit/autofill-apply-plan.test.ts.
 *
 * Nothing in the plan is trusted: the portal address must be a plain https
 * address (http and https on localhost only for dev builds), every id must be
 * a uuid, sensitive documents are refused unless the person asked for them,
 * and unknown profile keys are dropped. A plan that fails any check is
 * refused as a whole, with a message that names the field but never its value.
 */

import { HelperError } from "./errors.js";
import { parsePortalUrl } from "./hosts.js";
import { SENSITIVE_DOC_TYPES } from "./match.js";

export const PLAN_VERSION = 1;

/** The company facts a portal form can ask for (the same list the server sends). */
export const PROFILE_KEYS = Object.freeze([
  "legal_name",
  "trading_name",
  "registration_number",
  "csd_number",
  "vat_number",
  "tax_pin",
  "tax_pin_expires_at",
  "bbbee_level",
  "bbbee_expires_at",
  "cidb_grade",
  "authorised_signatory",
  "contact_person",
  "contact_email",
  "contact_phone",
  "physical_address",
  "postal_address",
  "website",
]);

export const SKIPPED_REASONS = Object.freeze(["not_available", "sensitive_not_requested"]);

const MAX_DOCUMENTS = 30;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {import("./match.js").HelperDocument & { label: string, sensitive: boolean }} PlanDocument
 */

/**
 * @typedef {Object} ApplyPlan
 * @property {string} generatedAt
 * @property {string} organisationName
 * @property {string} role
 * @property {{ id: string, title: string, reference_number: string | null, issuing_organisation: string, closing_at: string }} tender
 * @property {string} submissionId
 * @property {{ url: string, host: string, origin: string }} portal
 * @property {Record<string, string | number | null>} profile
 * @property {PlanDocument[]} documents
 * @property {Array<{ label: string, reason: string }>} skipped
 * @property {boolean} includeSensitive
 * @property {import("./match.js").HelperBid} bid  The plan as the field matcher takes it.
 */

/**
 * @param {string} field
 * @param {string} [message]
 */
function fail(field, message) {
  return new HelperError(message ?? `TenderOS sent a plan the helper could not use (${field}). Try again, or update the helper.`, "invalid_response");
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} v
 * @param {string} field
 * @param {number} max
 * @returns {string}
 */
function str(v, field, max) {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw fail(field);
  return v;
}

/**
 * @param {unknown} v
 * @param {string} field
 * @param {number} max
 * @returns {string | null}
 */
function strOrNull(v, field, max) {
  if (v === null || v === undefined) return null;
  return str(v, field, max);
}

/**
 * @param {unknown} v
 * @param {string} field
 * @returns {string}
 */
function uuid(v, field) {
  if (typeof v !== "string" || !UUID_PATTERN.test(v)) throw fail(field);
  return v;
}

/**
 * Validates a plan from TenderOS and returns it in the shape the helper uses.
 * @param {unknown} raw
 * @param {{ allowLocalhost?: boolean }} [options]
 * @returns {ApplyPlan}
 */
export function parseApplyPlan(raw, options = {}) {
  if (!isObject(raw)) throw fail("plan");
  if (raw.version !== PLAN_VERSION) {
    throw fail("version", "This TenderOS plan is for a different version of the helper. Update the helper and try again.");
  }

  const generatedAt = str(raw.generated_at, "generated_at", 40);
  if (!ISO_PATTERN.test(generatedAt)) throw fail("generated_at");
  const organisation = isObject(raw.organisation) ? raw.organisation : null;
  const member = isObject(raw.member) ? raw.member : null;
  if (!organisation || !member) throw fail("organisation");
  const organisationName = str(organisation.name, "organisation", 200);
  const role = str(member.role, "member", 20);

  const t = isObject(raw.tender) ? raw.tender : null;
  if (!t) throw fail("tender");
  const closingAt = str(t.closing_at, "tender.closing_at", 40);
  if (!ISO_PATTERN.test(closingAt)) throw fail("tender.closing_at");
  const tender = {
    id: uuid(t.id, "tender.id"),
    title: str(t.title, "tender.title", 500),
    reference_number: strOrNull(t.reference_number, "tender.reference_number", 200),
    issuing_organisation: str(t.issuing_organisation, "tender.issuing_organisation", 300),
    closing_at: closingAt,
  };
  const submissionId = uuid(raw.submission_id, "submission_id");

  const p = isObject(raw.portal) ? raw.portal : null;
  const portalMessage =
    "TenderOS did not give a usable portal address for this tender (it must be a plain https address). Open the portal yourself and use Fill this page.";
  if (!p) throw fail("portal", portalMessage);
  const parsedUrl = parsePortalUrl(p.url, { allowLocalhost: Boolean(options.allowLocalhost) });
  if (!parsedUrl.ok || p.host !== parsedUrl.host) throw fail("portal", portalMessage);
  const portal = { url: parsedUrl.url, host: parsedUrl.host, origin: parsedUrl.origin };

  const rawProfile = isObject(raw.profile) ? raw.profile : null;
  if (!rawProfile) throw fail("profile");
  /** @type {Record<string, string | number | null>} */
  const profile = {};
  for (const key of PROFILE_KEYS) {
    const v = rawProfile[key];
    if (v === undefined || v === null) profile[key] = null;
    else if (typeof v === "number" && Number.isFinite(v)) profile[key] = v;
    else if (typeof v === "string" && v.length <= 2000) profile[key] = v;
    else throw fail(`profile.${key}`);
  }

  if (typeof raw.include_sensitive !== "boolean") throw fail("include_sensitive");
  const includeSensitive = raw.include_sensitive;

  if (!Array.isArray(raw.documents) || raw.documents.length > MAX_DOCUMENTS) throw fail("documents");
  /** @type {PlanDocument[]} */
  const documents = [];
  const seen = new Set();
  for (const d of raw.documents) {
    if (!isObject(d)) throw fail("documents");
    const id = uuid(d.id, "documents.id");
    if (seen.has(id)) throw fail("documents.id");
    seen.add(id);
    const sensitive = d.sensitive;
    if (typeof sensitive !== "boolean") throw fail("documents.sensitive");
    const docType = str(d.doc_type, "documents.doc_type", 60);
    // The server never sends these unless the person ticked the option; refuse a plan that does anyway.
    if ((SENSITIVE_DOC_TYPES.has(docType) || sensitive) && (!includeSensitive || !SENSITIVE_DOC_TYPES.has(docType) || !sensitive)) {
      throw fail("documents.sensitive", "TenderOS sent personal documents the helper was not asked to attach, so it stopped. Try again, or update the helper.");
    }
    const size = d.size_bytes;
    if (size !== null && size !== undefined && (typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > MAX_FILE_BYTES))
      throw fail("documents.size_bytes");
    const expires = strOrNull(d.expires_at, "documents.expires_at", 40);
    if (expires !== null && !DATE_PATTERN.test(expires.slice(0, 10))) throw fail("documents.expires_at");
    documents.push({
      id,
      doc_type: docType,
      title: str(d.title, "documents.title", 300),
      file_name: str(d.file_name, "documents.file_name", 255),
      mime_type: strOrNull(d.mime_type, "documents.mime_type", 100),
      size_bytes: size ?? null,
      expires_at: expires,
      label: str(d.label, "documents.label", 300),
      sensitive,
    });
  }

  if (!Array.isArray(raw.skipped_documents) || raw.skipped_documents.length > 100) throw fail("skipped_documents");
  const skipped = raw.skipped_documents.map((s) => {
    if (!isObject(s) || typeof s.reason !== "string" || !SKIPPED_REASONS.includes(s.reason)) throw fail("skipped_documents");
    return { label: str(s.label, "skipped_documents.label", 300), reason: s.reason };
  });

  /** @type {import("./match.js").HelperBid} */
  const bid = {
    submission_id: submissionId,
    tender: {
      id: tender.id,
      title: tender.title,
      reference_number: tender.reference_number,
      issuing_organisation: tender.issuing_organisation,
      closing_at: tender.closing_at,
      submission_method: "ELECTRONIC_PORTAL",
      submission_destination: portal.url,
      source_url: null,
    },
    attachments: documents.map((d) => ({ key: d.doc_type, label: d.label, document_id: d.id, available: true })),
  };

  return { generatedAt, organisationName, role, tender, submissionId, portal, profile, documents, skipped, includeSensitive, bid };
}
