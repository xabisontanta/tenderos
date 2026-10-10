import { z } from "zod";

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

const serverSchema = publicSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  APP_URL: z.string().url().default("http://localhost:3000"),
});

/** Server-only configuration. Never import from client components. */
export function serverEnv() {
  return serverSchema.parse(process.env);
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
