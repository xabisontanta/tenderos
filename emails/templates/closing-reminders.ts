import { appLink, contextFor, nowFor, renderApp, type AppEmail, type AppEmailOptions } from "../app";
import { firstName, formatClosingShort, formatRemaining, humanize, plural, toDate } from "../format";
import type { Block, EmailContent, TenderRow, Tone } from "../layout";

export interface ClosingReminderItem {
  title: string;
  referenceNumber?: string | null;
  buyerName?: string | null;
  province?: string | null;
  closingAt: Date | string;
  /** TenderStatus, e.g. PREPARING_BID. Shown as words. */
  status: string;
  /** https link to the tender page. */
  url: string;
}

export interface ClosingRemindersInput {
  recipientName?: string | null;
  organisationName: string;
  items: readonly ClosingReminderItem[];
}

const HOUR = 3_600_000;
const GROUPS: ReadonlyArray<{ heading: string; tone: Tone; upToMs: number }> = [
  { heading: "Closing within 24 hours", tone: "danger", upToMs: 24 * HOUR },
  { heading: "Closing in the next 3 days", tone: "warning", upToMs: 72 * HOUR },
  { heading: "Closing this week", tone: "info", upToMs: 7 * 24 * HOUR },
  { heading: "Closing later", tone: "neutral", upToMs: Number.POSITIVE_INFINITY },
];

/**
 * The closing-date digest. Pure: the caller picks which tenders to include,
 * this groups them by how soon they close. Tenders that already closed are
 * left out, and an empty digest is an error so nothing blank is ever sent.
 */
export function renderClosingReminders(input: ClosingRemindersInput, options: AppEmailOptions): AppEmail {
  const ctx = contextFor(options);
  const now = nowFor(options);
  const name = firstName(input.recipientName);

  const upcoming = input.items
    .map((item) => ({ item, closing: toDate(item.closingAt) }))
    .filter(({ closing }) => closing.getTime() > now.getTime())
    .sort((a, b) => a.closing.getTime() - b.closing.getTime());
  if (!upcoming.length) throw new Error("No upcoming tenders to remind about");

  const grouped = GROUPS.map((g, i) => {
    const from = i === 0 ? 0 : GROUPS[i - 1].upToMs;
    return { ...g, rows: upcoming.filter(({ closing }) => closing.getTime() - now.getTime() > from && closing.getTime() - now.getTime() <= g.upToMs) };
  }).filter((g) => g.rows.length);

  const blocks: Block[] = [
    ...(name ? [{ type: "p", text: `Hi ${name},`, tight: true } as const] : []),
    { type: "p", text: ["Here is what closes soonest for ", { strong: input.organisationName }, ", earliest first."] },
    ...grouped.map((g): Block => ({
      type: "tenders",
      heading: g.heading,
      tone: g.tone,
      items: g.rows.map(({ item, closing }): TenderRow => ({
        title: item.title,
        href: item.url,
        meta: [item.referenceNumber, item.buyerName, item.province].filter((v): v is string => Boolean(v)),
        closes: formatClosingShort(closing),
        remaining: `Closes ${formatRemaining(closing.getTime() - now.getTime())}`,
        status: humanize(item.status),
      })),
    })),
    { type: "p", muted: true, text: "Times are South African Standard Time (SAST). A bid has to be approved and delivered before its tender closes." },
    { type: "button", label: "Open your tenders", href: appLink(ctx, "/tenders") },
  ];

  const urgent = grouped.find((g) => g.heading === GROUPS[0].heading)?.rows.length ?? 0;
  const week = upcoming.filter(({ closing }) => closing.getTime() - now.getTime() <= GROUPS[2].upToMs).length;
  let subject: string;
  if (urgent) {
    const more = week - urgent;
    subject = `${urgent} ${urgent === 1 ? "tender closes" : "tenders close"} within 24 hours${more > 0 ? `, ${more} more this week` : ""}`;
  } else if (upcoming.length === 1) {
    const only = upcoming[0];
    subject = `1 tender closes ${week ? "this week" : "later"}: ${only.item.title}`;
  } else {
    subject = week ? `${plural(week, "tender")} closing this week` : `${plural(upcoming.length, "tender")} on your list, closing soon`;
  }

  const content: EmailContent = {
    title: subject,
    preheader: `${upcoming[0].item.title} closes ${formatRemaining(upcoming[0].closing.getTime() - now.getTime())}.`,
    eyebrow: { label: "Closing dates", icon: "alarm-clock" },
    headline: urgent ? "Tenders closing within 24 hours" : "Tenders closing soon",
    blocks,
    reason: `you belong to ${input.organisationName} on TenderOS and tenders on your list are about to close`,
  };
  return renderApp(content, subject, ctx);
}
