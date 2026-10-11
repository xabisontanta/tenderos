/**
 * Sample data for previewing every email (npm run preview:emails) and for the
 * tests that check no template syntax is left behind. Everything here is
 * invented: example.co.za addresses, a fake code, no real person or tender.
 */
import { resolveBrand } from "./brand";
import { buildAuthTemplates } from "./build";
import { renderApprovalNeeded } from "./templates/approval-needed";
import { renderBidDelivered } from "./templates/bid-delivered";
import { renderClosingReminders } from "./templates/closing-reminders";
import { renderTeamInvitation } from "./templates/team-invitation";
import { renderWelcome } from "./templates/welcome";

/** The origin the preview pretends to be served from; rewritten to local files by the preview script. */
export const PREVIEW_ORIGIN = "https://app.example.co.za";

export const AUTH_SAMPLE_VARS: Record<string, string> = {
  SiteURL: PREVIEW_ORIGIN,
  Email: "thandi.mokoena@example.co.za",
  NewEmail: "thandi@mokoenacivil.example.co.za",
  OldEmail: "thandi.mokoena@example.co.za",
  Token: "482915",
  TokenHash: "pkce_5b1e7a1f3c",
  ConfirmationURL: "https://abcdefghijklmnop.supabase.co/auth/v1/verify?token=pkce_5b1e7a1f3c8d42e9a7d6&type=signup&redirect_to=https://app.example.co.za/auth/callback",
  FactorType: "totp",
  Provider: "google",
  Phone: "+27 82 555 0142",
  OldPhone: "+27 82 555 0100",
};

/**
 * Evaluates the small subset of Go templates the auth emails use: {{ .Var }},
 * {{ if eq .Var "x" }}, {{ else if eq .Var "y" }}, {{ else }}, {{ end }}.
 * An unknown variable throws, which is the failure the tests want to see.
 */
export function evaluateGoTemplate(source: string, vars: Record<string, string>): string {
  const tokens = source.split(/(\{\{[\s\S]*?\}\})/);
  const out: string[] = [];
  // Each open `if` tracks whether a branch was already taken and whether the current one is active.
  const stack: Array<{ parentActive: boolean; taken: boolean; active: boolean }> = [];
  const active = () => (stack.length ? stack[stack.length - 1].active : true);
  const lookup = (name: string) => {
    if (!(name in vars)) throw new Error(`Template variable .${name} has no sample value`);
    return vars[name];
  };
  for (const token of tokens) {
    const m = token.match(/^\{\{\s*([\s\S]*?)\s*\}\}$/);
    if (!m) {
      if (active()) out.push(token);
      continue;
    }
    const action = m[1];
    let c: RegExpMatchArray | null;
    if ((c = action.match(/^\.(\w+)$/))) {
      if (active()) out.push(lookup(c[1]));
    } else if ((c = action.match(/^if eq \.(\w+) "([^"]*)"$/))) {
      const parentActive = active();
      const hit = parentActive && lookup(c[1]) === c[2];
      stack.push({ parentActive, taken: hit, active: hit });
    } else if ((c = action.match(/^else if eq \.(\w+) "([^"]*)"$/))) {
      const top = stack[stack.length - 1];
      const hit = top.parentActive && !top.taken && lookup(c[1]) === c[2];
      top.active = hit;
      top.taken ||= hit;
    } else if (action === "else") {
      const top = stack[stack.length - 1];
      top.active = top.parentActive && !top.taken;
      top.taken = true;
    } else if (action === "end") {
      stack.pop();
    } else {
      throw new Error(`Unsupported template action: ${token}`);
    }
  }
  return out.join("");
}

export interface PreviewEmail {
  id: string;
  group: "Supabase Auth" | "Sent by TenderOS";
  label: string;
  subject: string;
  preheader: string;
  html: string;
  text?: string;
}

function preheaderOf(html: string): string {
  return html.match(/<body[^>]*>\s*<div style="display:none[^"]*">([^<]*)<\/div>/)?.[1].replaceAll("&#39;", "'").replaceAll("&amp;", "&").trim() ?? "";
}

const AUTH_LABELS: Record<string, string> = {
  confirmation: "Confirm sign-up",
  invite: "Invite user",
  magic_link: "Magic link",
  recovery: "Reset password",
  email_change: "Change email address",
  reauthentication: "Reauthentication code",
  password_changed: "Password changed",
  email_changed: "Email address changed",
  phone_changed: "Phone number changed",
  mfa_factor_enrolled: "Verification method added",
  mfa_factor_unenrolled: "Verification method removed",
  identity_linked: "Sign-in method linked",
  identity_unlinked: "Sign-in method removed",
};

export function previewEmails(opts: { now?: Date } = {}): PreviewEmail[] {
  const now = opts.now ?? new Date();
  const brand = resolveBrand({});
  const options = { appUrl: PREVIEW_ORIGIN, brand, production: true, now };
  const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();

  const auth = buildAuthTemplates(brand).map((t): PreviewEmail => {
    const html = evaluateGoTemplate(t.html, AUTH_SAMPLE_VARS);
    return {
      id: `auth-${t.key.replaceAll("_", "-")}`,
      group: "Supabase Auth",
      label: AUTH_LABELS[t.key] ?? t.key,
      subject: evaluateGoTemplate(t.subject, AUTH_SAMPLE_VARS),
      preheader: preheaderOf(html),
      html,
    };
  });

  const app: Array<[string, string, ReturnType<typeof renderWelcome>]> = [
    [
      "team-invitation",
      "Team invitation",
      renderTeamInvitation(
        {
          inviterName: "Thandi Mokoena",
          organisationName: "Mokoena Civil & Projects (Pty) Ltd",
          role: "operator",
          recipientEmail: "sipho.dlamini@example.co.za",
          acceptUrl: `${PREVIEW_ORIGIN}/invitations/accept?token=3f9c1a7e5b2d`,
          expiresAt: at(24 * 7),
        },
        options,
      ),
    ],
    ["welcome", "Welcome and setup checklist", renderWelcome({ recipientName: "Thandi Mokoena", organisationName: "Mokoena Civil & Projects (Pty) Ltd", completed: ["profile"] }, options)],
    [
      "approval-needed",
      "Approval needed",
      renderApprovalNeeded(
        {
          recipientName: "Thandi Mokoena",
          organisationName: "Mokoena Civil & Projects (Pty) Ltd",
          tenderTitle: "Supply and delivery of road marking paint for the Ekurhuleni roads maintenance programme",
          referenceNumber: "RFQ 2026/114",
          buyerName: "City of Ekurhuleni Metropolitan Municipality",
          closingAt: at(26),
          approvalUrl: `${PREVIEW_ORIGIN}/approvals`,
          submissionDestination: "scm@ekurhuleni.example.gov.za",
          openIssues: 2,
        },
        options,
      ),
    ],
    [
      "bid-delivered",
      "Bid delivered",
      renderBidDelivered(
        {
          recipientName: "Thandi Mokoena",
          organisationName: "Mokoena Civil & Projects (Pty) Ltd",
          tenderTitle: "Supply and delivery of road marking paint",
          referenceNumber: "RFQ 2026/114",
          buyerName: "City of Ekurhuleni",
          method: "EMAIL",
          deliveredBy: "Thandi Mokoena",
          deliveredAt: at(-2),
          deliveredTo: "scm@ekurhuleni.example.gov.za",
          fromAddress: "bids@mokoenacivil.example.co.za",
          attachments: [
            { filename: "Bid-document-RFQ-2026-114.pdf", bytes: 2_411_520 },
            { filename: "SARS-tax-compliance-status.pdf", bytes: 184_320 },
            { filename: "BBBEE-certificate.pdf", bytes: 96_256 },
          ],
          providerReference: "<CAFx3k9d2b7a@mail.example.co.za>",
          tenderUrl: `${PREVIEW_ORIGIN}/tenders/9b2c`,
        },
        options,
      ),
    ],
    [
      "closing-reminders",
      "Closing-date digest",
      renderClosingReminders(
        {
          recipientName: "Thandi Mokoena",
          organisationName: "Mokoena Civil & Projects (Pty) Ltd",
          items: [
            { title: "Road marking paint", referenceNumber: "RFQ 2026/114", buyerName: "City of Ekurhuleni", province: "Gauteng", closingAt: at(9), status: "READY_FOR_APPROVAL", url: `${PREVIEW_ORIGIN}/tenders/1` },
            { title: "Borehole drilling and equipping, Mopani District", referenceNumber: "T 77/2026", buyerName: "Mopani District Municipality", province: "Limpopo", closingAt: at(51), status: "PREPARING_BID", url: `${PREVIEW_ORIGIN}/tenders/2` },
            { title: "Security services for municipal buildings", referenceNumber: "SCM 12/2026", buyerName: "Msunduzi Municipality", province: "KwaZulu-Natal", closingAt: at(60), status: "MISSING_INFORMATION", url: `${PREVIEW_ORIGIN}/tenders/3` },
            { title: "Supply of PPE", referenceNumber: null, buyerName: "Department of Health", province: "Western Cape", closingAt: at(24 * 6), status: "QUALIFIED", url: `${PREVIEW_ORIGIN}/tenders/4` },
          ],
        },
        options,
      ),
    ],
  ];

  return [
    ...auth,
    ...app.map(
      ([id, label, email]): PreviewEmail => ({ id, group: "Sent by TenderOS", label, subject: email.subject, preheader: preheaderOf(email.html), html: email.html, text: email.text }),
    ),
  ];
}
