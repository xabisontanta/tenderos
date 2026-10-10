"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { getBrowserSupabase } from "@/lib/supabase/client";

export const LIVE_TABLES = ["agents", "tasks", "agent_events", "handoffs", "approvals", "tenders", "workflow_runs", "notifications", "discovery_runs"] as const;
export type LiveTable = (typeof LIVE_TABLES)[number];
export type ChangePayload = RealtimePostgresChangesPayload<Record<string, unknown>>;
type Listener = (payload: ChangePayload) => void;
export type ConnectionState = "connecting" | "live" | "error" | "closed";

interface RealtimeApi {
  subscribe(table: LiveTable, listener: Listener): () => void;
  state: ConnectionState;
}

const Ctx = createContext<RealtimeApi | null>(null);

/**
 * One Supabase Realtime channel per signed-in organisation. Postgres changes
 * are delivered only for rows the user may SELECT (RLS applies), and
 * fanned out to components that subscribe by table.
 */
export function RealtimeProvider({ organisationId, userId, children }: { organisationId: string; userId: string; children: React.ReactNode }) {
  const listeners = useRef(new Map<LiveTable, Set<Listener>>());
  const [state, setState] = useState<ConnectionState>("connecting");

  useEffect(() => {
    const supabase = getBrowserSupabase();
    let channel = supabase.channel(`org:${organisationId}`);
    for (const table of LIVE_TABLES) {
      const filter = table === "notifications" ? `user_id=eq.${userId}` : `organisation_id=eq.${organisationId}`;
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table, filter }, (payload) => {
        listeners.current.get(table)?.forEach((l) => l(payload as ChangePayload));
      });
    }
    let cancelled = false;
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) supabase.realtime.setAuth(data.session.access_token);
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") setState("live");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setState("error");
        else if (status === "CLOSED") setState("closed");
      });
    });
    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [organisationId, userId]);

  const api = useMemo<RealtimeApi>(
    () => ({
      state,
      subscribe(table, listener) {
        const set = listeners.current.get(table) ?? new Set();
        set.add(listener);
        listeners.current.set(table, set);
        return () => set.delete(listener);
      },
    }),
    [state],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useRealtime(): RealtimeApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useRealtime must be used inside RealtimeProvider");
  return ctx;
}
