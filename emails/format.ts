/** Formatting for app-sent emails: South African English, Africa/Johannesburg (UTC+2, no daylight saving). */

const TZ = "Africa/Johannesburg";

const dayFormat = new Intl.DateTimeFormat("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ });
const shortDayFormat = new Intl.DateTimeFormat("en-ZA", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
const timeFormat = new Intl.DateTimeFormat("en-ZA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TZ });

export function toDate(value: Date | string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${String(value)}`);
  return d;
}

/** "Friday, 16 October 2026 at 12:00 SAST" */
export function formatClosing(value: Date | string): string {
  const d = toDate(value);
  return `${dayFormat.format(d)} at ${timeFormat.format(d)} SAST`;
}

/** "Fri, 16 Oct, 12:00 SAST", for dense lists. */
export function formatClosingShort(value: Date | string): string {
  const d = toDate(value);
  return `${shortDayFormat.format(d)}, ${timeFormat.format(d)} SAST`;
}

/** "in 4 days 4 hours", "in 40 minutes", or "closed" once the time has passed. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "closed";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  const dayPart = `${days} ${days === 1 ? "day" : "days"}`;
  return rest ? `in ${dayPart} ${rest} ${rest === 1 ? "hour" : "hours"}` : `in ${dayPart}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** First word of a display name, or null when there is none. */
export function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first || null;
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Enum-style values such as PREPARING_BID become "Preparing bid". */
export function humanize(value: string): string {
  const s = value.replaceAll("_", " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Message ids are shown without their angle brackets so they survive plain-text clients. */
export function bareMessageId(id: string): string {
  return id.trim().replace(/^<|>$/g, "");
}
