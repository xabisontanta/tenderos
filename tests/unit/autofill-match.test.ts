import { describe, expect, it } from "vitest";
import {
  acceptsFile,
  buildPlan,
  formatDateFor,
  isMobileNumber,
  matchField,
  normalise,
  pickOption,
  provinceFromAddress,
  type FieldDescriptor,
  type HelperBid,
  type HelperDocument,
  type PlanInput,
} from "@/extension/src/match.js";

let next = 0;
const field = (d: Partial<FieldDescriptor>): FieldDescriptor => ({ index: next++, tag: "input", type: "text", ...d });
const text = (label: string, extra: Partial<FieldDescriptor> = {}) => field({ label, ...extra });
const file = (label: string, extra: Partial<FieldDescriptor> = {}) => field({ label, type: "file", ...extra });
const select = (label: string, options: string[], extra: Partial<FieldDescriptor> = {}) =>
  field({ label, tag: "select", type: "select-one", options: options.map((t, i) => ({ text: t, value: i === 0 ? "" : t })), ...extra });

const PROFILE: PlanInput["profile"] = {
  legal_name: "Acme Trading (Pty) Ltd",
  trading_name: "Acme Supplies",
  registration_number: "2015/123456/07",
  csd_number: "MAAA0123456",
  vat_number: "4123456789",
  tax_pin: "ABC1234XYZ",
  tax_pin_expires_at: "2027-03-31",
  bbbee_level: 2,
  bbbee_expires_at: "2027-01-31",
  cidb_grade: "5CE",
  authorised_signatory: "Thandi Mokoena",
  contact_person: "Sipho Ndlovu",
  contact_email: "tenders@acme.co.za",
  contact_phone: "082 555 0100",
  physical_address: "12 Main Road\nRosebank\nJohannesburg\nGauteng\n2196",
  postal_address: "PO Box 123, Rosebank, 2132",
  website: "https://acme.co.za",
};
const EMPTY_PROFILE: PlanInput["profile"] = Object.fromEntries(Object.keys(PROFILE).map((k) => [k, null]));

const doc = (id: string, doc_type: string, extra: Partial<HelperDocument> = {}): HelperDocument => ({
  id,
  doc_type,
  title: doc_type,
  file_name: `${doc_type}.pdf`,
  mime_type: "application/pdf",
  size_bytes: 1000,
  expires_at: null,
  ...extra,
});

const DOCS: HelperDocument[] = [
  doc("11111111-1111-4111-8111-111111111111", "tax_compliance"),
  doc("22222222-2222-4222-8222-222222222222", "tax_compliance", { file_name: "tcs-older.pdf" }),
  doc("33333333-3333-4333-8333-333333333333", "cipc_registration"),
  doc("44444444-4444-4444-8444-444444444444", "director_ids"),
  doc("55555555-5555-4555-8555-555555555555", "bbbee", { file_name: "bbbee.png", mime_type: "image/png" }),
];

const BID: HelperBid = {
  submission_id: "99999999-9999-4999-8999-999999999999",
  tender: {
    id: "88888888-8888-4888-8888-888888888888",
    title: "Supply of office furniture",
    reference_number: "RFQ-2026-014",
    issuing_organisation: "City of Johannesburg",
    closing_at: "2026-11-01T09:00:00Z",
    submission_method: "ELECTRONIC_PORTAL",
    submission_destination: null,
    source_url: "https://etenders.gov.za/x",
  },
  attachments: [{ key: "tax_compliance", label: "Tax", document_id: "22222222-2222-4222-8222-222222222222", available: true }],
};

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  profile: PROFILE,
  documents: DOCS,
  bid: null,
  today: "2026-10-10",
  includeSensitive: false,
  ...over,
});

describe("normalise", () => {
  it("folds South African spellings together", () => {
    expect(normalise("B-BBEE Status Level")).toBe("bbbee status level");
    expect(normalise("BEE level")).toBe("bbbee level");
    expect(normalise("P.O. Box")).toBe("po box");
    expect(normalise("Value Added Tax Number")).toBe("vat no");
    expect(normalise("Bidder's name")).toBe("bidders name");
    expect(normalise("Reg. No.")).toBe("reg no");
  });
});

describe("matchField: what a field asks for", () => {
  it.each([
    ["Name of bidder", "legal_name"],
    ["Registered company name", "legal_name"],
    ["Bidder's name", "legal_name"],
    ["Trading name (t/a)", "trading_name"],
    ["Company registration number", "registration_number"],
    ["CIPC registration no.", "registration_number"],
    ["CSD supplier number (MAAA)", "csd_number"],
    ["Central Supplier Database (CSD) number", "csd_number"],
    ["Unique registration reference number", "csd_registration_reference"],
    ["Income tax reference number", "income_tax_reference"],
    ["Tax compliance status PIN", "tax_pin"],
    ["TCS PIN", "tax_pin"],
    ["VAT registration number", "vat_number"],
    ["Value Added Tax (VAT) number", "vat_number"],
    ["B-BBEE status level of contributor", "bbbee_level"],
    ["CIDB grading", "cidb_grade"],
    ["CIDB CRS number", "cidb_crs_number"],
    ["Name of authorised signatory", "authorised_signatory"],
    ["Contact person", "contact_person"],
    ["E-mail address", "contact_email"],
    ["Telephone number", "contact_phone"],
    ["Contact number", "contact_phone"],
    ["Cellphone number", "cell_number"],
    ["Fax number", "fax_number"],
    ["Physical address", "physical_address"],
    ["Business address", "physical_address"],
    ["Postal address", "postal_address"],
    ["P.O. Box", "postal_address"],
    ["Website", "website"],
    ["Province", "province"],
    ["Tender number", "tender_reference"],
    ["Bid No.", "tender_reference"],
    ["RFQ reference", "tender_reference"],
  ])("%s → %s", (label, key) => {
    const m = matchField(text(label));
    expect(m).toMatchObject({ key });
    expect(m && "confidence" in m && m.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("reads name and id attributes, autocomplete and nearby text", () => {
    expect(matchField(field({ name: "ctl00$ContentPlaceHolder1$txtCompanyName", id: "ctl00_ContentPlaceHolder1_txtCompanyName" }))).toMatchObject({
      key: "legal_name",
    });
    expect(matchField(field({ name: "txtVATNo" }))).toMatchObject({ key: "vat_number" });
    expect(matchField(field({ name: "csdNumber" }))).toMatchObject({ key: "csd_number" });
    expect(matchField(field({ autocomplete: "organization" }))).toMatchObject({ key: "legal_name" });
    expect(matchField(field({ type: "email" }))).toMatchObject({ key: "contact_email" });
    expect(matchField(field({ nearby: "Company registration number" }))).toMatchObject({ key: "registration_number" });
  });

  it("leaves ambiguous fields unmatched instead of guessing", () => {
    for (const label of ["Full name", "Name", "Surname", "Address line 1", "Postal code", "City", "Supplier ID number", "Email of authorised signatory"]) {
      expect(matchField(text(label)), label).toBeNull();
    }
  });

  it.each([
    ["Signature", "signature"],
    ["Signature of authorised signatory", "signature"],
    ["Date signed", "signature"],
    ["Initials", "signature"],
    ["I hereby declare that the information above is true and correct", "declaration"],
    ["Declaration of interest: are you in the service of the state?", "declaration"],
    ["B-BBEE points claimed", "declaration"],
    ["Domicilium citandi et executandi", "declaration"],
    ["Total bid price (incl. VAT)", "price"],
    ["Unit rate", "price"],
    ["Amount", "price"],
    ["Tender sum", "price"],
    ["Contract value", "price"],
    ["Discount %", "price"],
    ["ID number", "id_number"],
    ["SA identity number of director", "id_number"],
    ["Passport number", "id_number"],
    ["Enter the characters shown (captcha)", "captcha"],
    ["One time PIN", "captcha"],
    ["Date of birth", "personal"],
    ["Gender", "personal"],
    ["Bank account number", "banking"],
    ["Branch code", "banking"],
  ])("never fills %s (%s)", (label, skip) => {
    expect(matchField(text(label))).toEqual({ skip });
    expect(matchField(field({ label, tag: "textarea", type: "textarea" }))).toEqual({ skip });
    expect(matchField(select(label, ["Select", "Yes", "No"]))).toEqual({ skip });
  });

  it("never fills passwords, sign-in forms, tick boxes or option buttons", () => {
    expect(matchField(field({ label: "Password", type: "password" }))).toEqual({ skip: "password" });
    expect(matchField(field({ name: "user_pwd" }))).toEqual({ skip: "password" });
    expect(matchField(field({ label: "Email", type: "email", inLoginForm: true }))).toEqual({ skip: "login" });
    expect(matchField(field({ label: "I accept the terms and conditions", type: "checkbox" }))).toEqual({ skip: "declaration" });
    expect(matchField(field({ label: "I certify that I am authorised to sign", type: "checkbox" }))).toEqual({ skip: "declaration" });
    expect(matchField(field({ label: "Gauteng", type: "radio" }))).toEqual({ skip: "choice" });
    expect(matchField(field({ label: "Company name", type: "checkbox" }))).toEqual({ skip: "choice" });
  });

  it.each([
    ["Upload tax clearance certificate / TCS PIN letter", "tax_compliance"],
    ["CSD registration report", "csd_registration"],
    ["Company registration documents (CIPC)", "cipc_registration"],
    ["Certificate of incorporation (CoR 14.3)", "cipc_registration"],
    ["B-BBEE certificate or sworn affidavit", "bbbee"],
    ["SBD 4: Declaration of interest", "sbd_declarations"],
    ["Signed SBD forms", "sbd_declarations"],
    ["CIDB grading certificate", "cidb_grading"],
    ["COIDA letter of good standing", "coida"],
    ["Public liability insurance", "insurance"],
    ["Company profile", "company_profile_doc"],
    ["Reference letters", "project_references"],
    ["Audited financial statements", "financial_statements"],
    ["Bank confirmation letter", "bank_confirmation"],
    ["Certified copies of directors' IDs", "director_ids"],
    ["Proof of address (utility bill)", "proof_of_address"],
  ])("file upload %s → %s", (label, docType) => {
    expect(matchField(file(label))).toMatchObject({ key: `document:${docType}` });
  });

  it("never attaches to signature or pricing uploads", () => {
    expect(matchField(file("Upload signature specimen"))).toEqual({ skip: "signature" });
    expect(matchField(file("Pricing schedule"))).toEqual({ skip: "price" });
    expect(matchField(file("Bill of quantities"))).toEqual({ skip: "price" });
  });
});

describe("option and value helpers", () => {
  it("picks the B-BBEE level option by its number", () => {
    const opts = ["-- Select --", "Level 1", "Level 2", "Level 12", "Non-compliant contributor"].map((t) => ({ text: t, value: t }));
    expect(pickOption(opts, "bbbee_level", 2)).toBe(2);
    expect(pickOption(opts, "bbbee_level", 1)).toBe(1);
    expect(pickOption(opts, "bbbee_level", 5)).toBe(-1);
    expect(pickOption([{ text: "Two", value: "2" }], "bbbee_level", 2)).toBe(0);
  });

  it("picks provinces without confusing North West and Northern Cape", () => {
    const opts = [
      { text: "Select", value: "" },
      { text: "North West", value: "NW" },
      { text: "Northern Cape", value: "NC" },
      { text: "KwaZulu-Natal", value: "KZN" },
      { text: "Gauteng", value: "GP" },
    ];
    expect(pickOption(opts, "province", "Northern Cape")).toBe(2);
    expect(pickOption(opts, "province", "North West")).toBe(1);
    expect(pickOption(opts, "province", "KwaZulu-Natal")).toBe(3);
    expect(pickOption(opts, "province", "Gauteng")).toBe(4);
    expect(pickOption(opts, "province", "Limpopo")).toBe(-1);
  });

  it("matches other selects only on a clear option", () => {
    const opts = ["Select", "5CE", "6CE", "5GB"].map((t) => ({ text: t, value: t }));
    expect(pickOption(opts, "cidb_grade", "5CE")).toBe(1);
    expect(pickOption(opts, "cidb_grade", "7CE")).toBe(-1);
  });

  it("reads the province only when the address names exactly one", () => {
    expect(provinceFromAddress("12 Main Road, Umhlanga, KwaZulu-Natal, 4319")).toBe("KwaZulu-Natal");
    expect(provinceFromAddress("1 Long Street, Cape Town, 8001")).toBeNull();
    expect(provinceFromAddress("Offices in Gauteng and the Western Cape")).toBeNull();
    expect(provinceFromAddress(null)).toBeNull();
  });

  it("checks accept attributes, mobile numbers and date formats", () => {
    const pdf = doc("a", "tax_compliance");
    expect(acceptsFile("", pdf)).toBe(true);
    expect(acceptsFile(".pdf,.docx", pdf)).toBe(true);
    expect(acceptsFile("application/pdf", pdf)).toBe(true);
    expect(acceptsFile("image/*", pdf)).toBe(false);
    expect(isMobileNumber("082 555 0100")).toBe(true);
    expect(isMobileNumber("+27 72 555 0100")).toBe(true);
    expect(isMobileNumber("011 555 0100")).toBe(false);
    expect(formatDateFor(field({ type: "date" }), "2027-01-31")).toBe("2027-01-31");
    expect(formatDateFor(field({ placeholder: "DD/MM/YYYY" }), "2027-01-31")).toBe("31/01/2027");
    expect(formatDateFor(field({}), "2027-01-31")).toBeNull();
  });
});

describe("buildPlan", () => {
  it("fills company details from the profile, shaped to each field", () => {
    const fields = [
      text("Name of bidder"),
      text("CSD supplier number"),
      text("B-BBEE status level"),
      select("B-BBEE level", ["Select", "Level 1", "Level 2", "Level 3"]),
      text("Physical address"),
      field({ label: "Physical address", tag: "textarea", type: "textarea" }),
      select("Province", ["Select", "Gauteng", "Limpopo"]),
      text("Cellphone"),
    ];
    const { steps, left } = buildPlan(fields, input());
    expect(left).toEqual([]);
    const byIndex = Object.fromEntries(steps.map((s) => [s.index, s]));
    expect(byIndex[fields[0].index]).toMatchObject({ action: "fill", value: "Acme Trading (Pty) Ltd", key: "legal_name" });
    expect(byIndex[fields[1].index]).toMatchObject({ action: "fill", value: "MAAA0123456" });
    expect(byIndex[fields[2].index]).toMatchObject({ action: "fill", value: "Level 2" });
    expect(byIndex[fields[3].index]).toMatchObject({ action: "select", optionIndex: 2, value: "Level 2" });
    expect(byIndex[fields[4].index]).toMatchObject({ action: "fill", value: "12 Main Road, Rosebank, Johannesburg, Gauteng, 2196" });
    expect(byIndex[fields[5].index]).toMatchObject({ action: "fill", value: PROFILE.physical_address });
    expect(byIndex[fields[6].index]).toMatchObject({ action: "select", optionIndex: 1 });
    expect(byIndex[fields[7].index]).toMatchObject({ action: "fill", value: "082 555 0100" });
  });

  it("never invents a value the profile does not hold", () => {
    const fields = [
      text("Name of bidder"),
      text("VAT number"),
      text("Income tax reference number"),
      text("Fax number"),
      select("Province", ["Select", "Gauteng"]),
      text("Tender number"),
    ];
    const { steps, left } = buildPlan(fields, input({ profile: EMPTY_PROFILE }));
    expect(steps).toEqual([]);
    expect(left.map((l) => l.reason)).toEqual(["missing", "missing", "missing", "missing", "missing", "no_tender"]);
  });

  it("leaves expired facts, non-mobile numbers, long values and filled fields for the person", () => {
    const fields = [
      text("Tax compliance PIN"),
      text("Cell number"),
      text("Company registration number", { maxLength: 5 }),
      text("Trading name", { hasValue: true }),
    ];
    const { steps, left } = buildPlan(fields, input({ profile: { ...PROFILE, tax_pin_expires_at: "2026-10-09", contact_phone: "011 555 0100" } }));
    expect(steps).toEqual([]);
    expect(left.map((l) => l.reason)).toEqual(["expired", "not_mobile", "too_long", "has_value"]);
  });

  it("produces no step for any field the safety rules cover, whatever its type", () => {
    const dangerous = [
      "Signature",
      "Date signed",
      "I hereby declare",
      "Total price",
      "Rate per hour",
      "ID number",
      "Captcha",
      "Bank account number",
      "Points claimed",
      "Password",
    ];
    const fields = dangerous.flatMap((label) => [
      text(label),
      field({ label, tag: "textarea", type: "textarea" }),
      field({ label, type: "number" }),
      select(label, ["Select", "Yes", "No", "Level 2", "Acme Trading (Pty) Ltd"]),
      field({ label, type: "checkbox" }),
      field({ label, type: "radio" }),
    ]);
    fields.push(field({ label: "Company name", type: "checkbox" }), field({ label: "Email", type: "password" }));
    const { steps, left } = buildPlan(fields, input({ bid: BID, includeSensitive: true }));
    expect(steps).toEqual([]);
    expect(left).toHaveLength(fields.length);
  });

  it("fills the tender number only from the picked bid", () => {
    const f = text("Tender number");
    expect(buildPlan([f], input()).left).toEqual([{ index: f.index, label: "Tender number", reason: "no_tender" }]);
    expect(buildPlan([f], input({ bid: BID })).steps).toEqual([
      { index: f.index, action: "fill", key: "tender_reference", label: "Tender number", confidence: 0.85, value: "RFQ-2026-014" },
    ]);
    const noRef = { ...BID, tender: { ...BID.tender, reference_number: null } };
    expect(buildPlan([f], input({ bid: noRef })).left[0].reason).toBe("tender_missing");
  });

  it("attaches documents, preferring the picked bid's pack", () => {
    const tax = file("Tax clearance certificate");
    expect(buildPlan([tax], input()).steps[0]).toMatchObject({ action: "attach", documentIds: ["11111111-1111-4111-8111-111111111111"] });
    expect(buildPlan([tax], input({ bid: BID })).steps[0]).toMatchObject({
      action: "attach",
      documentIds: ["22222222-2222-4222-8222-222222222222"],
      fileNames: ["tcs-older.pdf"],
    });
    const many = file("Tax clearance certificate", { multiple: true });
    expect(buildPlan([many], input()).steps[0]).toMatchObject({ documentIds: DOCS.filter((d) => d.doc_type === "tax_compliance").map((d) => d.id) });
  });

  it("attaches personal documents only when asked, and respects accepted file types", () => {
    const ids = file("Certified copies of ID documents");
    expect(buildPlan([ids], input()).left[0].reason).toBe("sensitive");
    expect(buildPlan([ids], input({ includeSensitive: true })).steps[0]).toMatchObject({ documentIds: ["44444444-4444-4444-8444-444444444444"] });
    expect(buildPlan([file("B-BBEE certificate", { accept: ".pdf" })], input()).left[0].reason).toBe("file_type");
    expect(buildPlan([file("COIDA letter of good standing")], input()).left[0].reason).toBe("no_document");
    expect(buildPlan([file("Tax clearance", { hasValue: true })], input()).left[0].reason).toBe("has_value");
  });

  it("does not report search boxes and reports unrecognised fields", () => {
    const { steps, left } = buildPlan([field({ type: "search", label: "Search tenders" }), text("Favourite colour")], input());
    expect(steps).toEqual([]);
    expect(left.map((l) => l.reason)).toEqual(["unmatched"]);
  });
});
