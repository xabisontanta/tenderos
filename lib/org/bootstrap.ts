import { AGENTS, DEPARTMENTS } from "@/agents/registry";

/** Registry payload for public.bootstrap_organisation (single source of truth: agents/registry.ts). */
export function registryPayload() {
  return {
    p_departments: DEPARTMENTS,
    p_agents: AGENTS.map(({ implemented: _implemented, ...a }) => a),
  };
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base.length >= 2 ? base : `org-${base}`;
}
