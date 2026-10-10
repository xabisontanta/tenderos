// @ts-check
/**
 * Field matching for the TenderOS browser helper. Pure functions only: no
 * DOM, no chrome APIs, so the rules are unit-tested (tests/unit/autofill-match.test.ts)
 * and shared by the background worker.
 *
 * Safety rules (never relaxed): the helper never fills declarations,
 * signatures, prices or amounts, passwords, security checks or SA ID numbers,
 * never ticks a box, and never guesses a value TenderOS does not hold.
 * When unsure it leaves the field for the person.
 */

/**
 * What the content script reports about one form field.
 * @typedef {Object} FieldDescriptor
 * @property {number} index        Position in the frame's scan; used to apply the plan.
 * @property {string} tag          "input" | "select" | "textarea"
 * @property {string} type         Input type ("text", "email", "file", "checkbox", ...), "select-one", "select-multiple" or "textarea".
 * @property {string} [name]
 * @property {string} [id]
 * @property {string} [autocomplete]
 * @property {string} [placeholder]
 * @property {string} [label]      Text of <label for>, a wrapping <label> or aria-labelledby.
 * @property {string} [ariaLabel]
 * @property {string} [nearby]     Nearby text: the previous table cell, a legend or a preceding text node.
 * @property {boolean} [inLoginForm]  The field's form also holds a password field.
 * @property {boolean} [hasValue]  The field already holds something the person entered.
 * @property {number} [maxLength]
 * @property {boolean} [multiple]
 * @property {string} [accept]
 * @property {Array<{ text: string, value: string }>} [options]
 */

/** @typedef {{ key: string, confidence: number }} FieldMatch */
/**
 * @typedef {"captcha"|"signature"|"declaration"|"price"|"id_number"|"personal"|"banking"|"password"|"login"|"choice"|"search"} SkipReason
 */
/** @typedef {{ skip: SkipReason }} FieldSkip */

/**
 * @typedef {Object} HelperDocument
 * @property {string} id
 * @property {string} doc_type
 * @property {string} title
 * @property {string} file_name
 * @property {string|null} mime_type
 * @property {number|null} size_bytes
 * @property {string|null} expires_at
 */

/**
 * @typedef {Object} HelperBid
 * @property {string} submission_id
 * @property {{ id: string, title: string, reference_number: string|null, issuing_organisation: string, closing_at: string,
 *              submission_method: string, submission_destination: string|null, source_url: string|null }} tender
 * @property {Array<{ key: string, label: string, document_id: string, available: boolean }>} attachments
 */

/**
 * @typedef {Object} PlanInput
 * @property {Record<string, string|number|null>} profile
 * @property {HelperDocument[]} documents
 * @property {HelperBid|null} bid
 * @property {string} today              YYYY-MM-DD in South Africa.
 * @property {boolean} includeSensitive  Attach ID copies, bank letters and proof of address.
 */

/**
 * @typedef {{ index: number, action: "fill", key: string, label: string, confidence: number, value: string }
 *   | { index: number, action: "select", key: string, label: string, confidence: number, optionIndex: number, value: string }
 *   | { index: number, action: "attach", key: string, label: string, confidence: number, documentIds: string[], fileNames: string[] }} PlanStep
 */
/** @typedef {{ index: number, label: string, reason: string }} LeftItem */

/** Documents only owners and admins receive; even then the person opts in per fill. */
export const SENSITIVE_DOC_TYPES = new Set(["director_ids", "bank_confirmation", "proof_of_address"]);

/** Fill only at or above this confidence. */
export const MIN_CONFIDENCE = 0.5;

/** Plain-language reasons shown in the popup for fields left to the person. */
export const REASON_TEXT = /** @type {Record<string, string>} */ ({
  unmatched: "Not recognised. Fill it in yourself.",
  unsure: "Not sure what this field wants. Fill it in yourself.",
  declaration: "Declaration or consent. Read it and complete it yourself.",
  choice: "Tick box or option. Choose it yourself.",
  signature: "Signature. Sign it yourself.",
  price: "Price or amount. Enter it yourself.",
  password: "Password. The helper never fills passwords.",
  captcha: "Security check. Complete it yourself.",
  login: "Sign-in form. The helper does not sign in for you.",
  id_number: "ID number. Enter it yourself.",
  personal: "Personal details. Enter them yourself.",
  banking: "Banking details. Enter them yourself.",
  has_value: "Already filled in. Left as it is.",
  missing: "Not in your TenderOS company profile.",
  tender_missing: "Not in the TenderOS tender record.",
  expired: "Expired in TenderOS. Update it on the Company page first.",
  no_tender: "Choose the tender in the helper to fill this.",
  no_option: "No option matches your TenderOS value. Choose it yourself.",
  too_long: "Your value is longer than this field allows. Fill it in yourself.",
  no_document: "No verified, in-date document of this type in TenderOS.",
  sensitive: "Personal or banking document. Tick the option in the helper to attach it.",
  file_type: "This field does not accept the document's file type.",
  date_format: "Date format unclear. Enter the date yourself.",
  not_mobile: "Your TenderOS number is not a cellphone number. Fill it in yourself.",
  download_failed: "Could not download the document from TenderOS. Attach it yourself.",
  too_large: "Too large to attach automatically. Attach it yourself.",
  changed: "The page changed before the helper could fill this.",
});

/** Short names for what the helper filled, shown in the popup. */
export const KEY_LABELS = /** @type {Record<string, string>} */ ({
  legal_name: "Registered company name",
  trading_name: "Trading name",
  registration_number: "Company registration number",
  csd_number: "CSD supplier number",
  vat_number: "VAT number",
  tax_pin: "Tax compliance PIN",
  tax_pin_expires_at: "Tax PIN expiry date",
  bbbee_level: "B-BBEE status level",
  bbbee_expires_at: "B-BBEE certificate expiry date",
  cidb_grade: "CIDB grading",
  authorised_signatory: "Authorised signatory",
  contact_person: "Contact person",
  contact_email: "Email",
  contact_phone: "Telephone",
  cell_number: "Cellphone",
  physical_address: "Physical address",
  postal_address: "Postal address",
  website: "Website",
  province: "Province",
  tender_reference: "Tender number",
  income_tax_reference: "Income tax reference number",
  fax_number: "Fax number",
  cidb_crs_number: "CIDB CRS number",
  csd_registration_reference: "CSD registration reference",
});

/** Profile keys the helper never has a value for; matched so the summary can say so. */
const NOT_HELD = new Set(["income_tax_reference", "fax_number", "cidb_crs_number", "csd_registration_reference"]);

/**
 * Lower-case words with South African tender vocabulary folded together
 * (B-BBEE spellings, P.O. Box, t/a, VAT, "number" and "no.").
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function normalise(text) {
  if (!text) return "";
  return String(text)
    .toLowerCase()
    .replace(/\bvalue[\s-]*added[\s-]*tax\b/g, "vat")
    .replace(/\bb\s*-?\s*b\s*-?\s*bee\b/g, "bbbee")
    .replace(/\bb\s*-?\s*bee\b/g, "bbbee")
    .replace(/\bbee\b/g, "bbbee")
    .replace(/\bp\s*\.?\s*o\s*\.?\s*box\b/g, "po box")
    .replace(/\bt\s*\/\s*a\b/g, "trading as")
    .replace(/\be\s*-?\s*mail\b/g, "email")
    .replace(/\bcell\s*-\s*phone\b/g, "cellphone")
    .replace(/['\u2019`]/g, "")
    .replace(/#/g, " no ")
    .replace(/[^a-z0-9%]+/g, " ")
    .replace(/\b(number|nr|num|nbr|no)\b/g, "no")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words that come from form frameworks rather than meaning (ASP.NET ids, prefixes). */
const ATTR_NOISE = /\b(ctl\d*|txt|tb|ddl|cbo|cmb|lbl|fld|inp|input|field|content|place ?holder\d*|frm|sel|chk|rb|rdo)\b/g;

/**
 * Words from name and id attributes: camelCase split, framework noise removed.
 * @param {string|null|undefined} text
 * @returns {string}
 */
function normaliseAttr(text) {
  const split = String(text || "")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return normalise(split).replace(ATTR_NOISE, " ").replace(/\s+/g, " ").trim();
}

const PRICE_RE =
  /\bprice|\bpricing\b|\bamounts?\b|\brates?\b|\btotals?\b|\bcosts?\b|\bcosting\b|\bsum\b|\bfees?\b|\bvalues?\b|\bdiscount|\bquantit|\bqty\b|\brands?\b|\bzar\b|\bincl(usive)? (of )?vat\b|\bexcl(usive)? (of )?vat\b|\bvat (amount|inclusive|exclusive)\b|\bbudget\b|\bestimat|\bturnover\b|\bmark ?up\b|\bmargin\b|\bpercent|%|\bpayment\b|\binvoice\b|\bfinancial offer\b|\bbid offer\b/;
const FILE_SIGNATURE_RE = /\bsignature\b|\bspecimen\b/;
const FILE_PRICE_RE = /\bpric(e|es|ing)\b|\bbill of quantities\b|\bboq\b|\bschedule of rates\b|\bfinancial (offer|proposal)\b|\bquotation\b|\bquote\b/;
const ID_RE = /\b(sa |rsa |south african )?id(entity)? (no|doc|document)\b|\bidentity (no|document|doc)\b|\bpassport\b|\bidno\b/;
const ID_EXEMPT =
  /\b(supplier|vendor|csd|company|enterprise|registration|tax|bid|tender|reference|user|login|member|customer|client|employer|record|application|transaction|unique|email|session|maaa|crs|cidb)\b/;
const DECLARATION_RE =
  /\bdeclar|\battest|\bhereby\b|\bsolemnly\b|\boath\b|\baffirm|\bcertify\b|\bundertak|\bconsent\b|\bi agree\b|\bwe agree\b|\bagree (to|with)\b|\baccept (the )?(terms|conditions)\b|\backnowledge|\btrue and correct\b|\bdomicilium\b|\bpoints claimed\b|\bclaim(ing)? points\b|\bconflict of interest\b|\bin the service of the state\b|\bperjury\b|\bcommissioner of oaths\b/;

const CAPTCHA_RE =
  /captcha|\bverification code\b|\bsecurity code\b|\b(enter|type) the (characters|code|text)\b|\bnot a robot\b|\botp\b|\bone time (pin|password)\b/;

/** Fields (not file uploads) the helper always leaves for the person. Checked in order. */
/** @type {Array<{ skip: SkipReason, re: RegExp }>} */
const SKIP_RULES = [
  { skip: "captcha", re: CAPTCHA_RE },
  {
    skip: "signature",
    re: /\bsignature\b|\bsign here\b|\binitials?\b|\be ?sign(ature|ed|ing)?\b|\bdigital(ly)? sign|\bdate signed\b|\bsigned (at|on|by|this)\b|\bspecimen\b/,
  },
  { skip: "declaration", re: DECLARATION_RE },
  { skip: "id_number", re: ID_RE },
  {
    skip: "personal",
    re: /\bdate of birth\b|\bdob\b|\bbirth date\b|\bgender\b|\bsex\b|\brace\b|\bethnic|\bdisabilit|\bnationality\b|\bcitizenship\b|\bmarital\b|\bresidential address\b|\bhome address\b/,
  },
  { skip: "banking", re: /\bbank\b|\bbanking\b|\baccount (no|holder|type|name)\b|\bbranch (code|name|no)\b|\biban\b|\bswift\b|\bbic\b/ },
];

const ADDRESS_PART =
  /\b(line ?[1-9]|line (one|two|three)|suburb|city|town|postal code|post code|postcode|zip|area code|code|province|country|unit|building|complex|street (no|name)|house no|erf|stand no|region|district|municipality|ward)\b/;
const PROFESSIONAL = /\b(professional|ecsa|sacpcmp|sacap|sacqsp|nhbrc|psira|hpcsa|council|vehicle|cidb|crs|vat|tax|csd|uif|coida|sars|paye|sdl|bbbee)\b/;
const OTHER_PERSON = /\b(signatory|director|shareholder|owner|member|employee|representative|referee|client|reference|manager|partner|proprietor)\b/;

/** @type {Array<{ key: string, re: RegExp, c: number, not?: RegExp }>} */
const FIELD_RULES = [
  { key: "csd_registration_reference", re: /\bunique registration reference\b/, c: 0.9 },
  { key: "cidb_crs_number", re: /\bcrs\b|\bcontractor registration no\b/, c: 0.85 },
  { key: "csd_number", re: /\bcsd\b|\bcentral supplier data ?base\b|\bmaaa\b/, c: 0.9 },
  { key: "csd_number", re: /\bsupplier (registration |reg )?no\b/, c: 0.6 },
  {
    key: "tax_pin_expires_at",
    re: /\b(tax|tcs|sars)\b.*\b(expiry|expires|expiration|valid until|validity)\b|\b(expiry|expiration|validity)\b.*\b(tax|tcs)\b/,
    c: 0.8,
  },
  { key: "bbbee_expires_at", re: /\bbbbee\b.*\b(expiry|expires|expiration|valid until|validity)\b|\b(expiry|expiration|validity)\b.*\bbbbee\b/, c: 0.8 },
  { key: "vat_number", re: /\bvat (registration |reg )?no\b|\bvat\b/, c: 0.85, not: /\b(registered|status|yes|exempt)\b/ },
  {
    key: "tax_pin",
    re: /\btax compliance (status )?(pin|no)\b|\btcs\b|\bcompliance pin\b|\b(tax|sars|tcs) pin\b|\btax clearance (pin|no|certificate no)\b|\bcompliance status pin\b/,
    c: 0.85,
  },
  { key: "income_tax_reference", re: /\bincome tax\b|\btax (reference|ref)\b|\btax no\b|\btax registration\b/, c: 0.8 },
  { key: "cidb_grade", re: /\bcidb\b/, c: 0.8, not: /\b(expiry|expires|valid|date|certificate no|points)\b/ },
  {
    key: "bbbee_level",
    re: /\bbbbee\b|\blevel of contribut|\bcontributor (status )?level\b|\bcontribution level\b/,
    c: 0.8,
    not: /\b(expiry|expires|valid|certificate no|agency|verification|issue|issued|date|points|ownership|owned|black|women|youth|procurement|spend)\b/,
  },
  { key: "registration_number", re: /\bcipc\b|\b(company|business|enterprise|entity) (registration|reg)\b/, c: 0.9, not: /\b(date|certificate)\b/ },
  { key: "registration_number", re: /\b(registration|reg) no\b|\benterprise no\b|\bcompany no\b/, c: 0.75, not: PROFESSIONAL },
  { key: "trading_name", re: /\btrading (name|as)\b|\btrade name\b/, c: 0.9 },
  {
    key: "authorised_signatory",
    re: /\bauthori[sz]ed (signatory|signatories|representative|person|official)\b|\bsignatory\b|\bduly authori[sz]ed\b/,
    c: 0.8,
    not: /\b(capacity|designation|position|title|email|phone|tel|telephone|cell|mobile|fax|contact|address)\b/,
  },
  {
    key: "contact_person",
    re: /\bcontact (person|name)\b|\bname of (the )?contact\b|\bperson to contact\b|\bcontact details name\b/,
    c: 0.85,
    not: /\b(email|phone|tel|telephone|cell|mobile|fax|no)\b/,
  },
  {
    key: "legal_name",
    re: /\b(registered|legal) (company |business |entity )?name\b|\bfull (company|business|entity|legal) name\b|\bname of (the )?(company|business|entity|enterprise|firm|organi[sz]ation|supplier|bidder|tenderer|vendor|service provider|bidding entity)\b|\b(company|business|entity|enterprise|firm|organi[sz]ation|supplier|bidder|tenderer|vendor|service provider)s? name\b/,
    c: 0.85,
    not: /\b(contact|person|director|signatory|bank|account|holder|trading)\b/,
  },
  { key: "contact_email", re: /\bemail\b/, c: 0.85, not: OTHER_PERSON },
  { key: "fax_number", re: /\bfax\b|\bfacsimile\b/, c: 0.9 },
  { key: "cell_number", re: /\b(cell|mobile|cellphone|cellular)\b/, c: 0.85, not: OTHER_PERSON },
  { key: "contact_phone", re: /\b(telephone|tel|phone|landline|contact no|office no|work no)\b/, c: 0.85, not: OTHER_PERSON },
  { key: "website", re: /\b(website|web site|web address|url|homepage|home page)\b/, c: 0.85 },
  { key: "postal_address", re: /\bpostal\b|\bpo box\b|\bmailing address\b|\bcorrespondence address\b/, c: 0.85, not: ADDRESS_PART },
  {
    key: "physical_address",
    re: /\b(physical|street|business|registered|office|site|head office|operating|company) address\b|\baddress of (the )?(business|company|premises|bidder)\b/,
    c: 0.85,
    not: ADDRESS_PART,
  },
  { key: "physical_address", re: /\baddress\b/, c: 0.6, not: new RegExp(`\\b(email|web|ip|url|postal)\\b|${ADDRESS_PART.source}`) },
  { key: "province", re: /\bprovince\b/, c: 0.75, not: /\b(provinces|operate|operating in|preferred|select all|delivery)\b/ },
  {
    key: "tender_reference",
    re: /\b(tender|bid|rfq|rfp|rfb|rft|quotation|quote|contract|eoi) (reference |ref )?(no|reference|ref|id|code)\b|\breference no of (the )?(tender|bid)\b/,
    c: 0.85,
  },
];

/** Document types by the words portals use for the upload. Order matters: SBD forms first. */
/** @type {Array<{ type: string, re: RegExp, c: number }>} */
const DOCUMENT_RULES = [
  { type: "sbd_declarations", re: /\b(sbd|mbd)\b|\bstandard bidding\b/, c: 0.9 },
  { type: "csd_registration", re: /\bcsd\b|\bcentral supplier data ?base\b|\bmaaa\b/, c: 0.9 },
  { type: "tax_compliance", re: /\btax (clearance|compliance|status|certificate|pin)\b|\btcs\b|\bsars\b/, c: 0.9 },
  { type: "bbbee", re: /\bbbbee\b|\blevel of contribut|\bempowerment\b/, c: 0.9 },
  { type: "bbbee", re: /\baffidavit\b/, c: 0.6 },
  { type: "cidb_grading", re: /\bcidb\b/, c: 0.9 },
  { type: "coida", re: /\bcoida\b|\bletter of good standing\b|\bgood standing\b|\bcompensation (fund|commissioner)\b|\bworkm[ae]ns? compensation\b/, c: 0.85 },
  { type: "insurance", re: /\binsurance\b|\bpublic liability\b|\bliability cover\b|\bindemnity\b/, c: 0.85 },
  { type: "bank_confirmation", re: /\bbank\b.*\b(confirmation|letter|account|details|stamped|rating)\b|\bconfirmation of bank/, c: 0.85 },
  { type: "proof_of_address", re: /\bproof of (address|residence)\b|\butility bill\b/, c: 0.9 },
  { type: "proof_of_address", re: /\bmunicipal (account|bill|statement)\b/, c: 0.55 },
  {
    type: "director_ids",
    re: /\bid (copies|copy|documents?)\b|\bidentity documents?\b|\bcopies of (the )?ids?\b|\bcopy of (the )?ids?\b|\bdirectors? ids?\b|\bids of (the )?(directors|members|shareholders)\b|\bpassports?\b/,
    c: 0.85,
  },
  { type: "financial_statements", re: /\bfinancial statements?\b|\bannual financials?\b|\baudited\b|\bafs\b|\bmanagement accounts\b|\bfinancials\b/, c: 0.85 },
  {
    type: "project_references",
    re: /\breference letters?\b|\breferences\b|\btestimonials?\b|\btrack record\b|\bprevious (work|projects|experience)\b|\bcompletion certificates?\b|\bappointment letters?\b/,
    c: 0.8,
  },
  { type: "company_profile_doc", re: /\bcompany profile\b|\bbusiness profile\b|\bcorporate profile\b|\bcapability statement\b|\bcompany brochure\b/, c: 0.85 },
  {
    type: "cipc_registration",
    re: /\bcipc\b|\bcompany registration\b|\bregistration (certificate|documents?)\b|\bcor ?14|\bcor ?39\b|\bcertificate of incorporation\b|\bincorporation\b|\bcm ?29\b|\bck ?1\b|\bfounding statement\b/,
    c: 0.85,
  },
  { type: "sbd_declarations", re: /\bdeclarations?\b|\bbidders? disclosure\b/, c: 0.6 },
];

/** Autocomplete tokens that name a profile value outright. */
const AUTOCOMPLETE_KEYS = /** @type {Record<string, [string, number]>} */ ({
  organization: ["legal_name", 0.8],
  email: ["contact_email", 0.9],
  tel: ["contact_phone", 0.8],
  "tel-national": ["contact_phone", 0.8],
  url: ["website", 0.9],
  "street-address": ["physical_address", 0.75],
});

/**
 * @param {FieldDescriptor} f
 * @returns {{ primary: string, attrs: string, nearby: string, all: string }}
 */
function texts(f) {
  const primary = normalise([f.label, f.ariaLabel, f.placeholder].filter(Boolean).join(" | "));
  const attrs = normaliseAttr([f.name, f.id].filter(Boolean).join(" "));
  const nearby = normalise(f.nearby);
  return { primary, attrs, nearby, all: [primary, attrs, nearby].filter(Boolean).join(" | ") };
}

/**
 * The first rule matching `text`, or null.
 * @param {string} text
 * @returns {{ key: string, c: number } | null}
 */
function firstFieldRule(text) {
  if (!text) return null;
  for (const r of FIELD_RULES) {
    if (r.re.test(text) && !(r.not && r.not.test(text))) return { key: r.key, c: r.c };
  }
  return null;
}

/**
 * Which document type a file upload asks for.
 * @param {FieldDescriptor} f
 * @returns {FieldMatch | FieldSkip | null}
 */
function matchDocument(f) {
  const t = texts(f);
  if (CAPTCHA_RE.test(t.all)) return { skip: "captcha" };
  if (FILE_SIGNATURE_RE.test(t.all)) return { skip: "signature" };
  if (FILE_PRICE_RE.test(t.all)) return { skip: "price" };
  for (const [text, weight] of /** @type {Array<[string, number]>} */ ([
    [t.primary, 1],
    [t.attrs, 0.85],
    [t.nearby, 0.75],
  ])) {
    if (!text) continue;
    for (const r of DOCUMENT_RULES) if (r.re.test(text)) return { key: `document:${r.type}`, confidence: round(r.c * weight) };
  }
  return null;
}

/** @param {number} n */
function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Decides what one form field asks for. Skip rules run first and win over
 * any match: a field that looks like a declaration, signature, price,
 * password, security check or ID number is always left for the person.
 * @param {FieldDescriptor} f
 * @returns {FieldMatch | FieldSkip | null}
 */
export function matchField(f) {
  const type = String(f.type || "").toLowerCase();
  const t = texts(f);
  if (type === "password" || /\bpass ?word\b|\bpasswd\b|\bpwd\b/.test(t.all)) return { skip: "password" };
  if (f.inLoginForm) return { skip: "login" };
  if (type === "search" || /^search\b|\bsearch (for|by|tenders?)\b/.test(t.primary || t.attrs)) return { skip: "search" };
  if (type === "file") return matchDocument(f);
  if (type === "checkbox" || type === "radio") {
    return { skip: DECLARATION_RE.test(t.all) || /\bsign/.test(t.all) ? "declaration" : "choice" };
  }
  for (const r of SKIP_RULES) {
    if (r.skip === "id_number") {
      if (ID_RE.test(t.all) && !ID_EXEMPT.test(t.primary || t.attrs)) return { skip: "id_number" };
      continue;
    }
    if (r.re.test(t.all)) return { skip: r.skip };
  }
  if (PRICE_RE.test(t.all) || (type === "number" && /\b(r|zar)\b/.test(t.all))) return { skip: "price" };

  const fromPrimary = firstFieldRule(t.primary);
  if (fromPrimary) return { key: fromPrimary.key, confidence: fromPrimary.c };
  const auto = String(f.autocomplete || "")
    .toLowerCase()
    .split(/\s+/)
    .map((tok) => AUTOCOMPLETE_KEYS[tok])
    .find(Boolean);
  if (auto) return { key: auto[0], confidence: auto[1] };
  const fromAttrs = firstFieldRule(t.attrs);
  if (fromAttrs) return { key: fromAttrs.key, confidence: round(fromAttrs.c * 0.85) };
  const fromNearby = firstFieldRule(t.nearby);
  if (fromNearby) return { key: fromNearby.key, confidence: round(fromNearby.c * 0.7) };
  if (type === "email") return { key: "contact_email", confidence: 0.7 };
  if (type === "url") return { key: "website", confidence: 0.7 };
  if (type === "tel") return { key: "contact_phone", confidence: 0.6 };
  return null;
}

/** Provinces with the spellings portals use. Short codes only count as a whole option. */
const PROVINCES = [
  { name: "Eastern Cape", words: ["eastern cape"], codes: ["ec"] },
  { name: "Free State", words: ["free state"], codes: ["fs"] },
  { name: "Gauteng", words: ["gauteng"], codes: ["gp", "gt"] },
  { name: "KwaZulu-Natal", words: ["kwazulu natal", "kwa zulu natal", "kzn"], codes: ["kzn", "kn"] },
  { name: "Limpopo", words: ["limpopo"], codes: ["lp", "lim"] },
  { name: "Mpumalanga", words: ["mpumalanga"], codes: ["mp"] },
  { name: "North West", words: ["north west"], codes: ["nw"] },
  { name: "Northern Cape", words: ["northern cape"], codes: ["nc"] },
  { name: "Western Cape", words: ["western cape"], codes: ["wc"] },
];

/**
 * The province named in an address, when exactly one is named. Never guessed
 * from a city or postal code.
 * @param {string|null|undefined} address
 * @returns {string|null}
 */
export function provinceFromAddress(address) {
  const t = ` ${normalise(address)} `;
  const found = PROVINCES.filter((p) => p.words.some((w) => t.includes(` ${w} `)));
  return found.length === 1 ? found[0].name : null;
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];

/**
 * The option to choose in a <select> for a TenderOS value, or -1 when none
 * clearly matches (the field is then left for the person).
 * @param {Array<{ text: string, value: string }>} options
 * @param {string} key
 * @param {string|number} value
 * @returns {number}
 */
export function pickOption(options, key, value) {
  const opts = options.map((o) => ({ text: normalise(o.text), value: normalise(o.value) }));
  if (key === "bbbee_level") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 8) return -1;
    const word = NUMBER_WORDS[n];
    const re = new RegExp(`^(bbbee )?(status )?(level )?(${n}|${word})( contributor)?$|\\blevel (${n}|${word})\\b`);
    return opts.findIndex((o) => !/\bnon\b/.test(o.text) && (re.test(o.text) || re.test(o.value)));
  }
  if (key === "province") {
    const p = PROVINCES.find((x) => x.name === value);
    if (!p) return -1;
    return opts.findIndex(
      (o) =>
        p.words.some((w) => ` ${o.text} `.includes(` ${w} `) || ` ${o.value} `.includes(` ${w} `)) || p.codes.includes(o.text) || p.codes.includes(o.value),
    );
  }
  const v = normalise(String(value));
  if (!v) return -1;
  const exact = opts.findIndex((o) => o.text === v || o.value === v);
  if (exact >= 0) return exact;
  if (v.length < 3) return -1;
  const partial = opts.map((o, i) => (` ${o.text} `.includes(` ${v} `) ? i : -1)).filter((i) => i >= 0);
  return partial.length === 1 ? partial[0] : -1;
}

/**
 * Whether a file input's `accept` attribute allows a document.
 * @param {string|undefined} accept
 * @param {HelperDocument} doc
 * @returns {boolean}
 */
export function acceptsFile(accept, doc) {
  const tokens = String(accept || "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tokens.length) return true;
  const ext = (/\.[a-z0-9]+$/.exec(doc.file_name.toLowerCase()) || [""])[0];
  const mime = String(doc.mime_type || "").toLowerCase();
  return tokens.some((tok) => (tok.startsWith(".") ? tok === ext : tok.endsWith("/*") ? mime.startsWith(tok.slice(0, -1)) : tok === mime));
}

/**
 * A South African cellphone number (06x, 07x, 08x).
 * @param {string} phone
 */
export function isMobileNumber(phone) {
  const digits = phone.replace(/\D/g, "");
  return /^0[6-8]\d{8}$/.test(digits) || /^27[6-8]\d{8}$/.test(digits);
}

/**
 * A YYYY-MM-DD date in the format a field asks for, or null when unclear.
 * @param {FieldDescriptor} f
 * @param {string} iso
 * @returns {string|null}
 */
export function formatDateFor(f, iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (String(f.type).toLowerCase() === "date") return `${y}-${mo}-${d}`;
  const hint = String(f.placeholder || "").toLowerCase();
  if (/dd\s*\/\s*mm\s*\/\s*(yyyy|ccyy)/.test(hint)) return `${d}/${mo}/${y}`;
  if (/dd\s*-\s*mm\s*-\s*(yyyy|ccyy)/.test(hint)) return `${d}-${mo}-${y}`;
  if (/(yyyy|ccyy)\s*\/\s*mm\s*\/\s*dd/.test(hint)) return `${y}/${mo}/${d}`;
  if (/(yyyy|ccyy)\s*-\s*mm\s*-\s*dd/.test(hint)) return `${y}-${mo}-${d}`;
  return null;
}

/**
 * A short human label for a field, for the popup summary.
 * @param {FieldDescriptor} f
 * @returns {string}
 */
export function fieldLabel(f) {
  const raw = f.label || f.ariaLabel || f.placeholder || f.nearby || f.name || f.id || f.type || "Field";
  const clean = String(raw)
    .replace(/\s+/g, " ")
    .replace(/[*:]+\s*$/, "")
    .trim();
  return clean.length > 80 ? `${clean.slice(0, 77)}…` : clean;
}

/**
 * The value TenderOS holds for a key, or why there is none.
 * @param {string} key
 * @param {FieldDescriptor} f
 * @param {PlanInput} input
 * @returns {{ value: string|number } | { reason: string }}
 */
function resolveValue(key, f, input) {
  const p = input.profile;
  if (NOT_HELD.has(key)) return { reason: "missing" };
  if (key === "tender_reference") {
    if (!input.bid) return { reason: "no_tender" };
    return input.bid.tender.reference_number ? { value: input.bid.tender.reference_number } : { reason: "tender_missing" };
  }
  if (key === "province") {
    const prov = provinceFromAddress(/** @type {string|null} */ (p.physical_address));
    return prov ? { value: prov } : { reason: "missing" };
  }
  if (key === "cell_number") {
    const phone = p.contact_phone;
    if (phone == null || phone === "") return { reason: "missing" };
    return isMobileNumber(String(phone)) ? { value: String(phone) } : { reason: "not_mobile" };
  }
  if (key === "tax_pin_expires_at" || key === "bbbee_expires_at") {
    const iso = p[key];
    if (iso == null || iso === "") return { reason: "missing" };
    const formatted = formatDateFor(f, String(iso));
    return formatted ? { value: formatted } : { reason: "date_format" };
  }
  const value = p[key];
  if (value == null || value === "") return { reason: "missing" };
  const expiry = key === "tax_pin" ? p.tax_pin_expires_at : key === "bbbee_level" ? p.bbbee_expires_at : null;
  if (expiry && String(expiry) < input.today) return { reason: "expired" };
  return { value };
}

/**
 * Text to type for a value, shaped to the field (one line in an input,
 * "Level 2" for a B-BBEE text box).
 * @param {string} key
 * @param {string|number} value
 * @param {FieldDescriptor} f
 * @returns {string}
 */
function textFor(key, value, f) {
  const type = String(f.type).toLowerCase();
  if (key === "bbbee_level") return type === "number" ? String(value) : `Level ${value}`;
  const s = String(value);
  return f.tag === "textarea" ? s : s.replace(/\s*\r?\n\s*/g, ", ");
}

/**
 * Turns a frame's scanned fields into fill steps and a list of fields left
 * for the person. Pure: the same input always gives the same plan.
 * @param {FieldDescriptor[]} fields
 * @param {PlanInput} input
 * @returns {{ steps: PlanStep[], left: LeftItem[] }}
 */
export function buildPlan(fields, input) {
  /** @type {PlanStep[]} */
  const steps = [];
  /** @type {LeftItem[]} */
  const left = [];
  const preferred = new Set((input.bid?.attachments ?? []).map((a) => a.document_id));

  for (const f of fields) {
    const label = fieldLabel(f);
    /** @param {string} reason */
    const leave = (reason) => left.push({ index: f.index, label, reason });
    const m = matchField(f);
    if (m === null) {
      leave("unmatched");
      continue;
    }
    if ("skip" in m) {
      if (m.skip !== "search") leave(m.skip);
      continue;
    }
    if (m.confidence < MIN_CONFIDENCE) {
      leave("unsure");
      continue;
    }
    if (f.hasValue) {
      leave("has_value");
      continue;
    }

    if (m.key.startsWith("document:")) {
      const docType = m.key.slice("document:".length);
      const ofType = input.documents.filter((d) => d.doc_type === docType);
      if (!ofType.length) {
        leave("no_document");
        continue;
      }
      if (SENSITIVE_DOC_TYPES.has(docType) && !input.includeSensitive) {
        leave("sensitive");
        continue;
      }
      const ordered = [...ofType.filter((d) => preferred.has(d.id)), ...ofType.filter((d) => !preferred.has(d.id))];
      const acceptable = ordered.filter((d) => acceptsFile(f.accept, d));
      if (!acceptable.length) {
        leave("file_type");
        continue;
      }
      const fromBid = acceptable.filter((d) => preferred.has(d.id));
      const chosen = f.multiple ? (fromBid.length ? fromBid : acceptable) : [acceptable[0]];
      steps.push({
        index: f.index,
        action: "attach",
        key: m.key,
        label,
        confidence: m.confidence,
        documentIds: chosen.map((d) => d.id),
        fileNames: chosen.map((d) => d.file_name),
      });
      continue;
    }

    const resolved = resolveValue(m.key, f, input);
    if ("reason" in resolved) {
      leave(resolved.reason);
      continue;
    }
    if (f.tag === "select") {
      const optionIndex = pickOption(f.options ?? [], m.key, resolved.value);
      if (optionIndex < 0) {
        leave("no_option");
        continue;
      }
      const opt = (f.options ?? [])[optionIndex];
      steps.push({
        index: f.index,
        action: "select",
        key: m.key,
        label,
        confidence: m.confidence,
        optionIndex,
        value: opt ? opt.text : String(resolved.value),
      });
      continue;
    }
    const type = String(f.type).toLowerCase();
    const isDateKey = m.key.endsWith("_expires_at");
    // Dates go only into date boxes or text boxes that show the format; nothing else goes into a date box.
    if (type === "date" ? !isDateKey : isDateKey && type !== "text" && type !== "") {
      leave("unsure");
      continue;
    }
    const text = textFor(m.key, resolved.value, f);
    if (f.maxLength && f.maxLength > 0 && text.length > f.maxLength) {
      leave("too_long");
      continue;
    }
    if (type === "number" && !/^\d+$/.test(text)) {
      leave("unsure");
      continue;
    }
    if (type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      leave("unsure");
      continue;
    }
    steps.push({ index: f.index, action: "fill", key: m.key, label, confidence: m.confidence, value: text });
  }
  return { steps, left };
}
