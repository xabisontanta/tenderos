"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { accentFor } from "@/components/command-centre/agent-avatar";
import { useNow, useTableChanges } from "@/features/realtime/hooks";
import { cn } from "@/lib/utils";
import { AgentDesk } from "./agent-desk";
import { useFloorState, type FloorData } from "./use-floor-state";

interface Flight {
  id: string;
  from: { x: number; y: number } | null;
  to: { x: number; y: number };
  label: string;
}

const FLIGHT_MS = 2400;

/**
 * The AI office. Departments are rooms; agents sit at desks. A line animates
 * between desks only when a HANDOFF_CREATED event is persisted.
 */
export function OfficeFloor({ initial }: { initial: FloorData }) {
  const { agents, taskById, tenderById } = useFloorState(initial);
  const now = useNow(20_000);
  const container = useRef<HTMLDivElement>(null);
  const desks = useRef(new Map<string, HTMLDivElement>());
  const [flights, setFlights] = useState<Flight[]>([]);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    if (!container.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(container.current);
    return () => ro.disconnect();
  }, []);

  const centre = useCallback((agentId: string | null | undefined) => {
    const el = agentId ? desks.current.get(agentId) : undefined;
    const root = container.current;
    if (!el || !root) return null;
    const r = el.getBoundingClientRect();
    const c = root.getBoundingClientRect();
    return { x: r.left - c.left + r.width / 2, y: r.top - c.top + r.height / 2 };
  }, []);

  useTableChanges("agent_events", (p) => {
    if (p.eventType !== "INSERT") return;
    const e = p.new as { id: string; event_type: string; payload: { from_agent_id?: string | null; to_agent_id?: string | null }; summary: string };
    if (e.event_type !== "HANDOFF_CREATED" || !e.payload?.to_agent_id) return;
    const to = centre(e.payload.to_agent_id);
    if (!to) return;
    const flight: Flight = { id: e.id, from: centre(e.payload.from_agent_id), to, label: e.summary };
    setFlights((f) => [...f, flight]);
    const ids = [e.payload.from_agent_id, e.payload.to_agent_id].filter(Boolean) as string[];
    setHighlight((h) => new Set([...h, ...ids]));
    setTimeout(() => {
      setFlights((f) => f.filter((x) => x.id !== flight.id));
      setHighlight((h) => {
        const n = new Set(h);
        ids.forEach((i) => n.delete(i));
        return n;
      });
    }, FLIGHT_MS);
  });

  return (
    <div ref={container} className="relative">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {initial.departments.map((dep) => {
          const members = agents.filter((a) => a.department_id === dep.id);
          const a = accentFor(dep.accent);
          const active = members.some((m) => m.status === "RUNNING");
          const working = members.filter((m) => !["IDLE", "COMPLETED", "DISABLED"].includes(m.status)).length;
          return (
            <section
              key={dep.id}
              aria-label={dep.name}
              className={cn("rounded-xl border bg-card/70 p-3.5 transition-shadow duration-700", active && cn(a.border, a.glow))}
            >
              <header className="mb-3 flex items-start justify-between gap-2">
                <div>
                  <h2 className={cn("text-sm font-semibold", a.text)}>{dep.name}</h2>
                  <p className="text-[11px] text-muted-foreground">{dep.description}</p>
                </div>
                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                  {working}/{members.length} active
                </span>
              </header>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {members.map((agent) => (
                  <AgentDesk
                    key={agent.id}
                    ref={(el) => {
                      if (el) desks.current.set(agent.id, el);
                      else desks.current.delete(agent.id);
                    }}
                    agent={agent}
                    accent={dep.accent}
                    task={agent.current_task_id ? taskById.get(agent.current_task_id) : undefined}
                    tender={agent.current_tender_id ? tenderById.get(agent.current_tender_id) : undefined}
                    now={now}
                    highlighted={highlight.has(agent.id)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <svg className="pointer-events-none absolute inset-0" width={size.w} height={size.h} aria-hidden>
        <defs>
          <linearGradient id="handoff-grad" x1="0" x2="1">
            <stop offset="0" stopColor="oklch(0.8 0.12 210)" stopOpacity="0.1" />
            <stop offset="1" stopColor="oklch(0.8 0.12 210)" stopOpacity="0.9" />
          </linearGradient>
        </defs>
        <AnimatePresence>
          {flights.map((f) => {
            const from = f.from ?? { x: f.to.x, y: Math.max(0, f.to.y - 120) };
            const mx = (from.x + f.to.x) / 2;
            const my = Math.min(from.y, f.to.y) - 60;
            const d = `M ${from.x} ${from.y} Q ${mx} ${my} ${f.to.x} ${f.to.y}`;
            return (
              <motion.g key={f.id} initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
                <motion.path
                  d={d}
                  fill="none"
                  stroke="url(#handoff-grad)"
                  strokeWidth={2}
                  strokeDasharray="1 0"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 1.1, ease: "easeInOut" }}
                />
                <motion.circle
                  r={4}
                  fill="oklch(0.85 0.12 210)"
                  initial={{ offsetDistance: "0%" }}
                  animate={{ offsetDistance: "100%" }}
                  transition={{ duration: 1.1, ease: "easeInOut" }}
                  style={{ offsetPath: `path("${d}")` }}
                />
              </motion.g>
            );
          })}
        </AnimatePresence>
      </svg>
      <div className="sr-only" aria-live="polite">
        {flights.map((f) => (
          <p key={f.id}>{f.label}</p>
        ))}
      </div>
    </div>
  );
}
