"use client";

import type { LiveTable } from "./realtime-provider";
import { useRefreshOn } from "./hooks";

/** Drop into a server-rendered page to refresh it when the listed tables change. */
export function LiveRefresh({ tables, tenderId, debounceMs }: { tables: LiveTable[]; tenderId?: string; debounceMs?: number }) {
  useRefreshOn(tables, {
    debounceMs,
    when: tenderId
      ? (p) => {
          const row = (p.eventType === "DELETE" ? p.old : p.new) as { tender_id?: string; id?: string };
          return row.tender_id === tenderId || row.id === tenderId;
        }
      : undefined,
  });
  return null;
}
