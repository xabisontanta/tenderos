import { z } from "zod";

type Env = Record<string, string | undefined>;

/**
 * Public configuration, safe to read in the browser. Next.js inlines
 * NEXT_PUBLIC_* values at build time, so each one is referenced explicitly.
 */
const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
});

export function publicEnv() {
  return publicSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The public origin of this deployment (for example https://app.tenderos.co.za),
 * used for every link TenderOS puts in an email or redirect. It comes only from
 * configuration: request headers (Origin, Host, X-Forwarded-*) are chosen by
 * the caller and must never decide where a sign-in or reset link points.
 *
 * Outside production an unset value falls back to the local dev server. In
 * production it is required, must be https (a local server excepted, for
 * end-to-end runs against `next start`) and must be an origin without a path.
 */
export function appUrl(env: Env = process.env): string {
  const production = env.NODE_ENV === "production";
  const raw = env.APP_URL?.trim();
  if (!raw) {
    if (production) throw new Error("APP_URL is required in production (the public https origin of the app)");
    return "http://localhost:3000";
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("APP_URL must be a URL such as https://app.example.com");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("APP_URL must start with https://");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("APP_URL must be the site origin only, without a path, query or fragment");
  if (production && url.protocol !== "https:" && !LOCAL_HOSTS.has(url.hostname)) throw new Error("APP_URL must use https in production");
  return url.origin;
}

const serverSchema = publicSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
});

/** Server-only configuration. Never import from client components. */
export function serverEnv() {
  return { ...serverSchema.parse(process.env), APP_URL: appUrl() };
}

const workerSchema = z.object({
  DATABASE_URL: z.string().min(1),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  SIMULATION_STEP_MS: z.coerce.number().int().min(0).max(120_000).default(4000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type WorkerEnv = z.infer<typeof workerSchema>;

export function workerEnv(): WorkerEnv {
  return workerSchema.parse(process.env);
}
