import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The hosted worker is called by name from the database (pg_cron -> private.call_edge_worker ->
 * /functions/v1/<name>), but Supabase deploys a function under its folder name unless supabase/config.toml
 * maps it. The two once disagreed (the cron job called `tenderos-worker`, the folder was `worker`) and the
 * hosted worker never ran. These tests fail if the target name, the mapping or the entrypoint drift apart.
 */
const root = path.resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

/** The function name the cron job calls: the last definition of private.call_edge_worker wins. */
function cronTargets(): string[] {
  const dir = path.join(root, "supabase/migrations");
  const names: string[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    for (const m of sql.matchAll(/\/functions\/v1\/([A-Za-z0-9_-]+)/g)) names.push(m[1]);
  }
  return names;
}

/** `[functions.<name>]` tables of config.toml with their key = value lines. */
function functionTables(toml: string): Record<string, Record<string, string>> {
  const tables: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      const fn = header[1].match(/^functions\.([A-Za-z0-9_-]+)$/);
      current = fn ? (tables[fn[1]] = {}) : null;
      continue;
    }
    const kv = line.match(/^([A-Za-z_]+)\s*=\s*(.+)$/);
    if (current && kv) current[kv[1]] = kv[2].trim();
  }
  return tables;
}

describe("hosted worker function name", () => {
  const targets = cronTargets();
  const tables = functionTables(read("supabase/config.toml"));

  it("is called under one name by the database", () => {
    expect(new Set(targets).size).toBe(1);
    expect(targets[0]).toBe("tenderos-worker");
  });

  it("is mapped in supabase/config.toml, with JWT verification on and an entrypoint that exists", () => {
    const table = tables[targets[0]];
    expect(table, `no [functions.${targets[0]}] in supabase/config.toml: the cron job calls a function nobody deploys under that name`).toBeDefined();
    expect(table.enabled).toBe("true");
    expect(table.verify_jwt).toBe("true");
    const entrypoint = JSON.parse(table.entrypoint) as string;
    expect(entrypoint).toBe("./functions/worker/index.ts");
    expect(existsSync(path.join(root, "supabase", entrypoint))).toBe(true);
  });

  it("maps no other function to the worker's folder under a different name", () => {
    const names = Object.entries(tables)
      .filter(([, t]) => t.entrypoint?.includes("functions/worker/"))
      .map(([name]) => name);
    expect(names).toEqual([targets[0]]);
  });

  it("is deployed by name in the README and the local development guide", () => {
    for (const doc of ["README.md", "docs/local-development.md"]) {
      const text = read(doc);
      expect(text, doc).toContain(`supabase functions deploy ${targets[0]}`);
      expect(text, doc).toContain("verify_jwt");
    }
  });
});
