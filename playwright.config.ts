import { config } from "dotenv";
import { defineConfig, devices } from "@playwright/test";

// The tests read the local stack's address and keys, as the worker does.
config({ path: [".env.local"], quiet: true });

const PORT = Number(process.env.E2E_PORT ?? 3100);

/**
 * End-to-end tests run against a production build (`npm run build` first),
 * the local Supabase stack and a real job worker started in global setup.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...(process.env as Record<string, string>),
      // Every link in an auth email or redirect is built from APP_URL (docs/auth.md);
      // point it at the server under test, which supabase/config.toml allows.
      APP_URL: `http://127.0.0.1:${PORT}`,
      // `next start` runs as production, which requires both. No proxy sets a client
      // address here, so only the per-email limits apply during the run.
      AUTH_RATE_LIMIT_SECRET: process.env.AUTH_RATE_LIMIT_SECRET || "e2e-only-auth-rate-limit-secret-0123456789abcdef",
      TRUSTED_IP_HEADER: process.env.TRUSTED_IP_HEADER || "x-forwarded-for",
    },
  },
});
