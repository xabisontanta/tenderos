const TZ = "Africa/Johannesburg";

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeStyle: "short", timeZone: TZ }).format(new Date(iso));
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeZone: TZ }).format(new Date(iso));
}

/** A closing date as South Africans read it, e.g. "10 Oct 2026, 11:00 SAST". Used in agent output text. */
export function formatSast(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TZ }).format(d)} SAST`;
}

/** The last instant a document dated YYYY-MM-DD is valid: the end of that day in South Africa (UTC+2, no DST). */
export function endOfDaySast(date: string): number {
  return Date.parse(`${date.slice(0, 10)}T23:59:59.999+02:00`);
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-ZA", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: TZ }).format(new Date(iso));
}

export function formatZar(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 }).format(value);
}

export function formatUsd(value: number | null | undefined): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value ?? 0);
}

export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 45_000) return diff < 0 ? "just now" : "in a moment";
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  return rtf.format(Math.round(diff / 86_400_000), "day");
}

export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const s = value.replaceAll("_", " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const PROVINCES: Array<{ value: string; label: string }> = [
  { value: "EASTERN_CAPE", label: "Eastern Cape" },
  { value: "FREE_STATE", label: "Free State" },
  { value: "GAUTENG", label: "Gauteng" },
  { value: "KWAZULU_NATAL", label: "KwaZulu-Natal" },
  { value: "LIMPOPO", label: "Limpopo" },
  { value: "MPUMALANGA", label: "Mpumalanga" },
  { value: "NORTH_WEST", label: "North West" },
  { value: "NORTHERN_CAPE", label: "Northern Cape" },
  { value: "WESTERN_CAPE", label: "Western Cape" },
  { value: "NATIONAL", label: "National" },
  { value: "UNKNOWN", label: "Unknown" },
];

export function provinceLabel(v: string | null | undefined) {
  return PROVINCES.find((p) => p.value === v)?.label ?? "—";
}
