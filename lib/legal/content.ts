/**
 * Placeholder text for /terms and /privacy.
 *
 * DRAFT. Each section is an outline derived from a row of the document table in
 * docs/legal/popia-overview.md (`source` is that row's number), written from what
 * the product actually does (AGENTS.md, docs/security.md). It states no legal
 * terms the project has not decided: anything that needs the attorney or the
 * product owner says "to be confirmed". Replace this file with
 * attorney-reviewed text, and publish it as a new version (lib/legal/versions.ts),
 * before TenderOS is offered to customers.
 */
export interface LegalSection {
  heading: string;
  /** Row number in the "Documents to prepare" table of docs/legal/popia-overview.md. */
  source: number;
  body: string[];
}

export const DRAFT_NOTICE =
  "DRAFT. This is placeholder text prepared by an AI assistant from an internal outline. It is not legal advice and has not been reviewed by an attorney. It will be replaced with attorney-reviewed text before TenderOS is offered to customers. Do not rely on it.";

export const TERMS_SECTIONS: LegalSection[] = [
  {
    heading: "Acceptable use",
    source: 2,
    body: [
      "Use TenderOS for your own business, or as a consultant for clients who have authorised you to act for them. Keep your sign-in private.",
      "Do not upload information you have no right to share, try to disrupt or probe the service, or use it to break the law. The full acceptable-use terms are to be confirmed by the attorney.",
    ],
  },
  {
    heading: "No guarantee of award",
    source: 2,
    body: [
      "TenderOS helps you find tenders and prepare bids. It does not promise that a bid will be complete, compliant, delivered in time or awarded. The tender rules and closing dates set by the issuer always apply.",
    ],
  },
  {
    heading: "Human approval of every submission",
    source: 2,
    body: [
      "Software agents prepare, check and fill in documents. An owner or administrator of your organisation approves each bid, and a person signs the declarations and submits to the portal or sends the email. TenderOS never submits a bid on your behalf.",
    ],
  },
  {
    heading: "Artificial intelligence limits",
    source: 2,
    body: [
      "Parts of the work are done with artificial intelligence. Its output can be wrong or incomplete, so check everything before you rely on it. Facts that are not in your records or the tender documents are marked as missing or as needing your confirmation rather than guessed.",
      "The wording of the limits that apply to AI-assisted work is to be confirmed by the attorney.",
    ],
  },
  {
    heading: "Limitation of liability",
    source: 2,
    body: ["To be confirmed by the attorney: the limit on liability, indemnities, and how an error in an extracted tender requirement is treated."],
  },
  {
    heading: "Personal information we handle for you",
    source: 3,
    body: [
      "Your organisation decides what company and personal information, such as directors' details in uploaded documents, goes into TenderOS. For that information TenderOS acts as your operator under POPIA. The operator agreement (purposes, security measures, sub-operators, breach notice, return or deletion on exit) is to be confirmed by the attorney.",
    ],
  },
  {
    heading: "Termination",
    source: 2,
    body: ["How either side ends the agreement, and what happens to your data afterwards, is to be confirmed by the attorney."],
  },
  {
    heading: "Governing law",
    source: 2,
    body: ["South African law is intended to govern these terms. The courts and dispute-resolution steps are to be confirmed by the attorney."],
  },
];

export const PRIVACY_SECTIONS: LegalSection[] = [
  {
    heading: "Who is responsible",
    source: 1,
    body: [
      "For your sign-in details and how you use TenderOS, TenderOS is the responsible party under POPIA. For the company information and personal information your organisation uploads, your organisation is the responsible party and TenderOS acts as its operator.",
      "The company name, registration details and address of the operator are to be confirmed.",
    ],
  },
  {
    heading: "What we collect",
    source: 1,
    body: [
      "Account details: your name, email address and sign-in and usage records. Your organisation's profile, tenders, documents and bid records. A record of the version of these documents you accepted, when, and a keyed hash (not the address itself) of the network address you were using.",
      "Documents may contain personal information of directors and staff, such as identity documents. Those categories are restricted inside TenderOS to the people and agents that need them.",
    ],
  },
  {
    heading: "Why we use it",
    source: 1,
    body: [
      "To run the service you asked for: finding tenders, preparing bids and recording your approvals. To keep it secure: for example, sign-in attempts are limited per network address and per email, using keyed hashes rather than the raw values. To meet legal duties. The full list of purposes is to be confirmed by the attorney.",
    ],
  },
  {
    heading: "Who receives it (sub-processors)",
    source: 4,
    body: [
      "Supabase (database, file storage and sign-in), our hosting provider (Vercel or similar), Anthropic (artificial intelligence), Google (only if you connect Gmail for sending bids), Cloudflare (human verification at sign-in, when switched on) and a transactional email provider for account emails (to be confirmed).",
      "Locations and safeguards for each are to be confirmed and listed here.",
    ],
  },
  {
    heading: "Transfers outside South Africa",
    source: 5,
    body: [
      "Our database provider has no South African region and our AI provider is abroad, so some information is processed outside South Africa. The basis for these transfers under POPIA section 72 is to be confirmed by the attorney.",
    ],
  },
  {
    heading: "Artificial intelligence processing",
    source: 13,
    body: [
      "When AI preparation is switched on, tender documents and company facts are sent to an AI provider to prepare bids.",
      "The intended rule, to be confirmed and enforced in the product before launch, is that director personal information and bank details are never sent to AI. Inside TenderOS those categories are already restricted to the document manager.",
    ],
  },
  {
    heading: "How long we keep it",
    source: 9,
    body: [
      "Audit records are kept for at least 365 days (about seven years by default). Retention for other information, and what is deleted when an account or organisation is closed, is to be confirmed.",
    ],
  },
  {
    heading: "How we protect it",
    source: 10,
    body: [
      "Each organisation's data is separated by database access rules. Connections are encrypted. Mailbox passwords and tokens are kept in an encrypted vault. Consequential actions are recorded in an append-only audit trail. A summary of measures is to be confirmed.",
    ],
  },
  {
    heading: "Your rights",
    source: 8,
    body: [
      "You may ask to see, correct or delete your personal information, or object to how it is used. The request channel, identity checks and response times are to be confirmed.",
    ],
  },
  {
    heading: "Cookies",
    source: 15,
    body: ["TenderOS uses only the cookies needed to keep you signed in. It sets no advertising or tracking cookies."],
  },
  {
    heading: "Information Officer and contact",
    source: 6,
    body: ["The Information Officer, the contact mailbox for requests and the security contact are to be confirmed."],
  },
];
