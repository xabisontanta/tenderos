export const HOUR_MS = 3_600_000;

export function hoursUntil(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  return (new Date(iso).getTime() - now.getTime()) / HOUR_MS;
}
