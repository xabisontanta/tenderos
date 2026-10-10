"use client";

import { useRealtime } from "./realtime-provider";
import { cn } from "@/lib/utils";

const LABEL = { connecting: "Connecting", live: "Live", error: "Realtime unavailable", closed: "Disconnected" } as const;

export function ConnectionIndicator() {
  const { state } = useRealtime();
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground" role="status" aria-live="polite">
      <span
        className={cn(
          "size-1.5 rounded-full",
          state === "live" && "bg-emerald-400",
          state === "connecting" && "bg-amber-400 animate-pulse",
          (state === "error" || state === "closed") && "bg-red-400",
        )}
        aria-hidden
      />
      {LABEL[state]}
    </span>
  );
}
