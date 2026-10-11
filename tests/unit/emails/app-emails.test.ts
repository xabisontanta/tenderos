import { describe, expect, it } from "vitest";
import { resolveBrand } from "@/emails/brand";
import { formatBytes, formatClosing, formatRemaining, firstName } from "@/emails/format";
import { renderApprovalNeeded } from "@/emails/templates/approval-needed";
import { renderBidDelivered } from "@/emails/templates/bid-delivered";
import { renderClosingReminders } from "@/emails/templates/closing-reminders";
import { renderTeamInvitation } from "@/emails/templates/team-invitation";
import { renderWelcome } from "@/emails/templates/welcome";

const now = new Date("2026-10-12T08:00:00+02:00");
const options = { appUrl: "https://app.example.co.za", brand: resolveBrand({}), production: true, now };
const EVIL = `<script>alert("x")</script> "><img src=x onerror=alert(1)> & 'q'`;

const invitation = {
  inviterName: "Thandi Mokoena",
  organisationName: "Mokoena Civil & Projects (Pty) Ltd",
  role: "operator" as const,
  recipientEmail: "sipho@example.co.za",
  acceptUrl: "https://app.example.co.za/invitations/accept?token=abc123",
  expiresAt: "2026-10-19T14:30:00+02:00",
};
const approval = {
  recipientName: "Thandi Mokoena",
  organisationName: "Mokoena Civil & Projects (Pty) Ltd",
  tenderTitle: "Supply and delivery of road marking paint",
  referenceNumber: "RFQ 2026/114",
  buyerName: "City of Ekurhuleni",
  closingAt: "2026-10-16T12:00:00+02:00",
  approvalUrl: "https://app.example.co.za/approvals",
  openIssues: 2,
};
const delivered = {
  recipientName: "Thandi Mokoena",
  organisationName: "Mokoena Civil & Projects (Pty) Ltd",
  tenderTitle: "Supply and delivery of road marking paint",
  referenceNumber: "RFQ 2026/114",
  buyerName: "City of Ekurhuleni",
  method: "EMAIL" as const,
  deliveredBy: "Thandi Mokoena",
  deliveredAt: "2026-10-14T09:12:00+02:00",
  deliveredTo: "scm@ekurhuleni.example.gov.za",
  fromAddress: "bids@mokoena.example.co.za",
  attachments: [
    { filename: "Bid-document.pdf", bytes: 2_411_520 },
    { filename: "Tax-compliance.pdf", bytes: 184_320 },
  ],
  providerReference: "<CAF=abc@mail.example.co.za>",
  tenderUrl: "https://app.example.co.za/tenders/9b2c",
};
const reminders = {
  recipientName: "Thandi",
  organisationName: "Mokoena Civil & Projects (Pty) Ltd",
  items: [
    {
      title: "Road marking paint",
      referenceNumber: "RFQ 2026/114",
      buyerName: "City of Ekurhuleni",
      province: "Gauteng",
      closingAt: "2026-10-12T16:00:00+02:00",
      status: "PREPARING_BID",
      url: "https://app.example.co.za/tenders/1",
    },
    {
      title: "Borehole drilling, Limpopo",
      referenceNumber: "T 77/2026",
      buyerName: "Mopani District",
      province: "Limpopo",
      closingAt: "2026-10-14T11:00:00+02:00",
      status: "READY_FOR_APPROVAL",
      url: "https://app.example.co.za/tenders/2",
    },
    {
      title: "Security services",
      referenceNumber: null,
      buyerName: null,
      province: null,
      closingAt: "2026-10-18T10:00:00+02:00",
      status: "QUALIFIED",
      url: "https://app.example.co.za/tenders/3",
    },
  ],
};

const cases = [
  ["team invitation", () => renderTeamInvitation(invitation, options)],
  ["welcome", () => renderWelcome({ recipientName: "Thandi Mokoena", organisationName: "Mokoena Civil", completed: ["profile"] }, options)],
  ["approval needed", () => renderApprovalNeeded(approval, options)],
  ["bid delivered", () => renderBidDelivered(delivered, options)],
  ["closing reminders", () => renderClosingReminders(reminders, options)],
] as const;

describe.each(cases)("%s", (_name, render) => {
  const email = render();

  it("returns a subject, HTML and plain text", () => {
    expect(email.subject.length).toBeGreaterThan(8);
    expect(email.subject.length).toBeLessThanOrEqual(78);
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.html.startsWith("<!doctype html>")).toBe(true);
    expect(email.text.length).toBeGreaterThan(100);
    expect(email.text).not.toMatch(/<[a-z][^>]*>/i);
  });

  it("is table based with inline styles, a hidden preheader and nothing external", () => {
    expect(email.html).toContain('role="presentation"');
    expect(email.html).toMatch(/<div style="display:none[^"]*mso-hide:all">[^<]{20,}/);
    expect(email.html).not.toMatch(/<script|<link\b|@import|@font-face/i);
    expect(email.html).toContain("@media (prefers-color-scheme: dark)");
    expect(Buffer.byteLength(email.html)).toBeLessThan(90 * 1024);
  });

  it("serves images from the app origin with alt, width and height", () => {
    const imgs = email.html.match(/<img\b[^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(img).toMatch(/src="https:\/\/app\.example\.co\.za\/email\/[a-z0-9@-]+\.png"/);
      expect(img).toMatch(/\balt="/);
      expect(img).toMatch(/\bwidth="\d+"/);
      expect(img).toMatch(/\bheight="\d+"/);
    }
  });

  it("links over https only and leaves no template syntax behind", () => {
    const html = email.html.replace(/xmlns(:\w+)?="[^"]*"/g, "");
    expect(html).not.toMatch(/http:\/\//);
    expect(html).not.toMatch(/\{\{|\}\}/);
    expect(email.text).not.toMatch(/\{\{/);
  });

  it("ends with the legal sender block and the reason the email was sent", () => {
    expect(email.html).toContain("[Registered company name]");
    expect(email.html).toMatch(/You are receiving this email because/);
  });
});

describe("HTML injection", () => {
  const evilInvitation = renderTeamInvitation({ ...invitation, inviterName: EVIL, organisationName: EVIL, recipientEmail: `${EVIL}@example.co.za` }, options);
  const evilApproval = renderApprovalNeeded(
    { ...approval, recipientName: EVIL, organisationName: EVIL, tenderTitle: EVIL, referenceNumber: EVIL, buyerName: EVIL },
    options,
  );
  const evilDelivered = renderBidDelivered(
    {
      ...delivered,
      recipientName: EVIL,
      organisationName: EVIL,
      tenderTitle: EVIL,
      referenceNumber: EVIL,
      buyerName: EVIL,
      deliveredBy: EVIL,
      deliveredTo: EVIL,
      fromAddress: EVIL,
      providerReference: EVIL,
      attachments: [{ filename: EVIL, bytes: 10 }],
    },
    options,
  );
  const evilWelcome = renderWelcome({ recipientName: EVIL, organisationName: EVIL }, options);
  const evilReminders = renderClosingReminders(
    {
      recipientName: EVIL,
      organisationName: EVIL,
      items: [
        {
          title: EVIL,
          referenceNumber: EVIL,
          buyerName: EVIL,
          province: EVIL,
          closingAt: "2026-10-13T10:00:00+02:00",
          status: EVIL,
          url: "https://app.example.co.za/tenders/1",
        },
      ],
    },
    options,
  );

  it.each([
    ["team invitation", evilInvitation],
    ["approval needed", evilApproval],
    ["bid delivered", evilDelivered],
    ["welcome", evilWelcome],
    ["closing reminders", evilReminders],
  ])("%s escapes names, titles and references in the HTML", (_n, email) => {
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toMatch(/<img src=x/);
    expect(email.html).not.toMatch(/onerror=alert\(1\)>/);
    expect(email.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(email.html).toContain("&#39;q&#39;");
  });

  it("keeps header-injection characters out of the subject", () => {
    const e = renderTeamInvitation({ ...invitation, inviterName: "Eve\r\nBcc: victim@example.co.za", organisationName: "Org" }, options);
    expect(e.subject).not.toMatch(/[\r\n]/);
  });

  it("shortens a long organisation name instead of producing a 200 character subject", () => {
    const e = renderTeamInvitation({ ...invitation, organisationName: "X".repeat(300) }, options);
    expect(e.subject.length).toBeLessThanOrEqual(78);
    expect(e.subject).toMatch(/….* on TenderOS$/);
  });

  it.each([["javascript:alert(1)"], ["http://app.example.co.za/accept"], ["//evil.example/accept"], [""]])("refuses the accept link %s", (acceptUrl) => {
    expect(() => renderTeamInvitation({ ...invitation, acceptUrl }, options)).toThrow(/unsafe link/i);
  });

  it("refuses an http APP_URL in production", () => {
    expect(() => renderTeamInvitation(invitation, { ...options, appUrl: "http://app.example.co.za" })).toThrow(/https/);
  });
});

describe("team invitation", () => {
  const e = renderTeamInvitation(invitation, options);
  it("says who invited you, to what, as what, until when", () => {
    expect(e.subject).toBe("Thandi Mokoena invited you to join Mokoena Civil & Projects (Pty) Ltd");
    expect(e.html).toContain("Thandi Mokoena");
    expect(e.html).toContain("Mokoena Civil &amp; Projects (Pty) Ltd");
    expect(e.html).toContain("Operator");
    expect(e.html).toContain("cannot approve or send");
    expect(e.html).toContain("Monday, 19 October 2026 at 14:30 SAST");
    expect(e.html).toContain("in 7 days");
    expect(e.html).toContain("sipho@example.co.za");
    expect(e.html).toContain('href="https://app.example.co.za/invitations/accept?token=abc123"');
    expect(e.text).toContain("https://app.example.co.za/invitations/accept?token=abc123");
  });
  it("tells a stranger what to do", () => {
    expect(e.html).toMatch(/Don&#39;t know Thandi Mokoena\?/);
  });
  it("uses a short subject when the names are short", () => {
    expect(renderTeamInvitation({ ...invitation, organisationName: "Acme" }, options).subject).toBe("Thandi Mokoena invited you to join Acme on TenderOS");
  });
});

describe("welcome", () => {
  it("lists the setup steps with links, marking finished ones", () => {
    const e = renderWelcome({ recipientName: "Thandi Mokoena", organisationName: "Mokoena Civil", completed: ["profile"] }, options);
    expect(e.html).toContain("Hi Thandi,");
    for (const path of ["/documents", "/discover", "/settings", "/tenders"]) expect(e.html).toContain(`href="https://app.example.co.za${path}"`);
    expect(e.html).not.toContain('href="https://app.example.co.za/company"');
    const fresh = renderWelcome({ organisationName: "Mokoena Civil" }, options);
    expect(fresh.html).toContain('href="https://app.example.co.za/company"');
    expect(fresh.html).not.toContain("&#10003;");
    expect(e.html).toContain("&#10003;");
    expect(e.html).toMatch(/Done<\/span>/);
    expect(e.html).not.toContain("line-through");
    expect(e.text).toContain("[x] ");
  });
  it("greets without a name when none is known", () => {
    expect(renderWelcome({ organisationName: "Mokoena Civil" }, options).html).toContain("Welcome to TenderOS");
  });
});

describe("approval needed", () => {
  const e = renderApprovalNeeded(approval, options);
  it("names the tender, the deadline and the time left, and links to the decision", () => {
    expect(e.subject).toBe("Approval needed: Supply and delivery of road marking paint");
    expect(e.html).toContain("RFQ 2026/114");
    expect(e.html).toContain("City of Ekurhuleni");
    expect(e.html).toContain("Friday, 16 October 2026 at 12:00 SAST");
    expect(e.html).toContain("in 4 days 4 hours");
    expect(e.html).toContain('href="https://app.example.co.za/approvals"');
  });
  it("flags open QA issues and explains that approval lapses at closing", () => {
    expect(e.html).toContain("2 open issues");
    expect(e.html).toMatch(/lapses when the tender closes/);
    expect(e.html).toMatch(/Nothing is sent until you approve/);
  });
  it("says so when the tender has already closed", () => {
    const closed = renderApprovalNeeded({ ...approval, closingAt: "2026-10-11T12:00:00+02:00" }, options);
    expect(closed.html).toContain("This tender has closed");
  });
});

describe("bid delivered", () => {
  const e = renderBidDelivered(delivered, options);
  it("states what was delivered, to whom, from where and with what", () => {
    expect(e.subject).toBe("Bid delivered: Supply and delivery of road marking paint");
    expect(e.html).toContain("scm@ekurhuleni.example.gov.za");
    expect(e.html).toContain("bids@mokoena.example.co.za");
    expect(e.html).toContain("Bid-document.pdf");
    expect(e.html).toContain("2.3 MB");
    expect(e.html).toContain("180 KB");
    expect(e.html).toContain("Wednesday, 14 October 2026 at 09:12 SAST");
    expect(e.text).toContain("CAF=abc@mail.example.co.za");
    expect(e.text).not.toContain("<CAF");
  });
  it("is honest that TenderOS only knows the mailbox accepted the message", () => {
    expect(e.html).toMatch(/mailbox accepted the message/);
    expect(e.html).toMatch(/ask the buyer to confirm/);
  });
  it("words a hand-delivered bid differently", () => {
    const manual = renderBidDelivered(
      { ...delivered, method: "MANUAL", deliveredTo: null, fromAddress: null, attachments: [], providerReference: null },
      options,
    );
    expect(manual.html).toMatch(/recorded that the approved bid was delivered by hand or on the buyer&#39;s portal/);
    expect(manual.html).not.toMatch(/mailbox accepted/);
  });
});

describe("closing reminders", () => {
  const e = renderClosingReminders(reminders, options);
  it("groups tenders by how soon they close, soonest first", () => {
    expect(e.subject).toBe("1 tender closes within 24 hours, 2 more this week");
    const urgent = e.html.indexOf("Closing within 24 hours");
    const soon = e.html.indexOf("Closing in the next 3 days");
    const week = e.html.indexOf("Closing this week");
    expect(urgent).toBeGreaterThan(-1);
    expect(soon).toBeGreaterThan(urgent);
    expect(week).toBeGreaterThan(soon);
    expect(e.html).toContain("in 8 hours");
    expect(e.html).toContain("Ready for approval");
    expect(e.html).toContain("Preparing bid");
  });
  it("links each tender and shows its reference, buyer and province", () => {
    expect(e.html).toContain('href="https://app.example.co.za/tenders/1"');
    expect(e.html).toContain("RFQ 2026/114");
    expect(e.html).toContain("Mopani District");
    expect(e.html).toContain("Limpopo");
  });
  it("leaves out tenders that already closed and refuses to send an empty reminder", () => {
    const past = { ...reminders.items[0], closingAt: "2026-10-12T07:00:00+02:00" };
    const out = renderClosingReminders({ ...reminders, items: [past, reminders.items[1]] }, options);
    expect(out.html).not.toContain("Road marking paint");
    expect(() => renderClosingReminders({ ...reminders, items: [past] }, options)).toThrow(/No upcoming/);
  });
  it("uses the singular and a plain subject for a single tender", () => {
    expect(renderClosingReminders({ ...reminders, items: [reminders.items[1]] }, options).subject).toBe(
      "1 tender closes this week: Borehole drilling, Limpopo",
    );
  });
});

describe("formatting helpers", () => {
  it("writes closing dates the way South Africans read them", () => {
    expect(formatClosing("2026-10-16T12:00:00+02:00")).toBe("Friday, 16 October 2026 at 12:00 SAST");
  });
  it.each([
    [40 * 60_000, "in 40 minutes"],
    [60 * 60_000, "in 1 hour"],
    [5 * 3_600_000, "in 5 hours"],
    [26 * 3_600_000, "in 1 day 2 hours"],
    [48 * 3_600_000, "in 2 days"],
    [7 * 24 * 3_600_000, "in 7 days"],
    [-1000, "closed"],
  ])("formats %i ms as %s", (ms, label) => expect(formatRemaining(ms)).toBe(label));
  it.each([
    [0, "0 KB"],
    [900, "1 KB"],
    [184_320, "180 KB"],
    [2_411_520, "2.3 MB"],
  ])("formats %i bytes as %s", (bytes, label) => expect(formatBytes(bytes)).toBe(label));
  it("takes the first name, or nothing", () => {
    expect(firstName("  Thandi  Mokoena ")).toBe("Thandi");
    expect(firstName(null)).toBeNull();
    expect(firstName("   ")).toBeNull();
  });
});
