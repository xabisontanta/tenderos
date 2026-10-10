"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRealtime, type ChangePayload, type LiveTable } from "./realtime-provider";

/** Subscribe to changes on a table for the lifetime of the component. */
export function useTableChanges(table: LiveTable, onChange: (p: ChangePayload) => void) {
  const { subscribe } = useRealtime();
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => subscribe(table, (p) => ref.current(p)), [subscribe, table]);
}

/**
 * Keeps a list of rows in sync with realtime changes. Rows outside the
 * optional filter are dropped, so lists stay scoped to what the view shows.
 */
export function useLiveRows<T extends { id: string }>(
  table: LiveTable,
  initial: T[],
  opts: { filter?: (row: T) => boolean; sort?: (a: T, b: T) => number; limit?: number } = {},
): T[] {
  const [rows, setRows] = useState<T[]>(initial);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => setRows(initial), [initial]);

  useTableChanges(table, (p) => {
    const { filter, sort, limit } = optsRef.current;
    setRows((prev) => {
      let next = prev;
      if (p.eventType === "DELETE") {
        const id = (p.old as { id?: string }).id;
        next = prev.filter((r) => r.id !== id);
      } else {
        const row = p.new as unknown as T;
        const exists = prev.some((r) => r.id === row.id);
        const keep = !filter || filter(row);
        if (!keep) next = prev.filter((r) => r.id !== row.id);
        else next = exists ? prev.map((r) => (r.id === row.id ? { ...r, ...row } : r)) : [row, ...prev];
      }
      if (sort) next = [...next].sort(sort);
      if (limit) next = next.slice(0, limit);
      return next;
    });
  });
  return rows;
}

/**
 * Re-renders server components (router.refresh) when any of the given tables
 * change, debounced. Used for aggregates computed on the server.
 */
export function useRefreshOn(tables: LiveTable[], opts: { debounceMs?: number; when?: (p: ChangePayload) => boolean } = {}) {
  const router = useRouter();
  const { subscribe } = useRealtime();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const key = tables.join(",");

  useEffect(() => {
    const unsubs = key.split(",").map((t) =>
      subscribe(t as LiveTable, (p) => {
        if (optsRef.current.when && !optsRef.current.when(p)) return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => router.refresh(), optsRef.current.debounceMs ?? 400);
      }),
    );
    return () => {
      unsubs.forEach((u) => u());
      if (timer.current) clearTimeout(timer.current);
    };
  }, [key, router, subscribe]);
}

/** Re-renders periodically so relative timestamps stay accurate. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
