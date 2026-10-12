import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, ".") } },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    // Keep the structured logger quiet: tests that exercise failure paths would
    // otherwise print info and warning lines between the results.
    env: { LOG_LEVEL: "error" },
  },
});
