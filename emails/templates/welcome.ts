import { appLink, contextFor, renderApp, type AppEmail, type AppEmailOptions } from "../app";
import { firstName } from "../format";
import type { EmailContent, StepItem } from "../layout";

export type WelcomeStepKey = "profile" | "documents" | "provinces" | "mailbox" | "first_tender";

export interface WelcomeInput {
  recipientName?: string | null;
  organisationName: string;
  /** Steps already done; they are shown ticked. */
  completed?: readonly WelcomeStepKey[];
}

/** The setup path, in the order that unblocks a first bid fastest. Paths are real routes under app/(app). */
const STEPS: ReadonlyArray<{ key: WelcomeStepKey; path: string; title: string; body: string; cta: string }> = [
  {
    key: "profile",
    path: "/company",
    title: "Complete your company profile",
    body: "Add your sectors, provinces and CIDB grade. They decide which tenders count as a fit for you.",
    cta: "Open your company profile",
  },
  {
    key: "documents",
    path: "/documents",
    title: "Upload your compliance documents",
    body: "CIPC registration, CSD report, SARS tax compliance status and B-BBEE certificate. A document only counts as evidence once it is verified and still valid on the closing date.",
    cta: "Open the document vault",
  },
  {
    key: "provinces",
    path: "/discover",
    title: "Choose the provinces to watch",
    body: "The Tender Scout checks National Treasury eTenders for them every morning, and whenever you ask it to.",
    cta: "Choose provinces",
  },
  {
    key: "mailbox",
    path: "/settings",
    title: "Connect the mailbox you send bids from",
    body: "Approved bids go out from your own Gmail or company mailbox when you press Send. TenderOS never submits a bid itself.",
    cta: "Connect a mailbox",
  },
  {
    key: "first_tender",
    path: "/tenders",
    title: "Review your first tender",
    body: "Open a tender to see its deadline, whether it qualifies and what is still missing before you can bid.",
    cta: "See your tenders",
  },
];

/** Sent once, after the organisation is created. */
export function renderWelcome(input: WelcomeInput, options: AppEmailOptions): AppEmail {
  const ctx = contextFor(options);
  const done = new Set(input.completed ?? []);
  const name = firstName(input.recipientName);
  const left = STEPS.filter((s) => !done.has(s.key)).length;

  const steps: StepItem[] = STEPS.map((s) => ({
    title: s.title,
    body: s.body,
    done: done.has(s.key),
    link: done.has(s.key) ? undefined : { href: appLink(ctx, s.path), text: s.cta },
  }));

  const content: EmailContent = {
    title: "Welcome to TenderOS",
    preheader: left === STEPS.length ? "Five steps take you from an empty workspace to your first bid." : `${left} of ${STEPS.length} steps left before your first bid.`,
    eyebrow: { label: "Getting started", icon: "layout-dashboard" },
    headline: "Welcome to TenderOS",
    blocks: [
      ...(name ? [{ type: "p", text: `Hi ${name},`, tight: true } as const] : []),
      {
        type: "p",
        text: [
          "The workspace for ",
          { strong: input.organisationName },
          " is ready. These steps take you from an empty account to your first bid. Do them in any order; the first two matter most.",
        ],
      },
      { type: "steps", items: steps },
      { type: "button", label: "Open your workspace", href: appLink(ctx, "/") },
      { type: "p", muted: true, text: "You approve every bid before anything is sent, and you can pause any agent at any time from the Office." },
    ],
    reason: `you created a TenderOS workspace for ${input.organisationName}`,
  };
  return renderApp(content, name ? `Welcome to TenderOS, ${name}: your first steps` : "Welcome to TenderOS: your first steps", ctx);
}
