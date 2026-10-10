"use client";

import { useEffect, useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

interface Health {
  online: boolean;
  workers: number;
  lastSeen: string | null;
}

/** Shows whether a background worker is actually processing agent work. */
export function WorkerStatus({ initial }: { initial: Health }) {
  const [health, setHealth] = useState(initial);
  useEffect(() => {
    const supabase = getBrowserSupabase();
    const check = async () => {
      const { data } = await supabase.rpc("worker_health");
      const row = data?.[0];
      setHealth({ online: (row?.workers ?? 0) > 0, workers: row?.workers ?? 0, lastSeen: row?.last_seen_at ?? null });
    };
    const t = setInterval(check, 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
      title={health.lastSeen ? `Last heartbeat ${health.lastSeen}` : "No heartbeat recorded"}
    >
      <span className={cn("size-1.5 rounded-full", health.online ? "bg-emerald-400" : "bg-red-400")} aria-hidden />
      {health.online ? `Agent worker online${health.workers > 1 ? ` (${health.workers})` : ""}` : "Agent worker offline"}
    </span>
  );
}
