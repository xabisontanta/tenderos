import { spawn } from "node:child_process";

/** Starts a real job worker for the duration of the run and stops it afterwards. */
export default async function globalSetup() {
  const url = process.env.DATABASE_URL ?? "";
  if (url && !/127\.0\.0\.1|localhost/.test(url)) throw new Error("E2E tests only run against a local database");
  const worker = spawn("npx", ["tsx", "scripts/worker.ts"], { stdio: ["ignore", "pipe", "inherit"], env: process.env, detached: true });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not start")), 30_000);
    worker.stdout!.on("data", (b: Buffer) => {
      if (b.toString().includes("worker started")) {
        clearTimeout(timer);
        resolve();
      }
    });
    worker.on("exit", (code) => reject(new Error(`worker exited with ${code}`)));
  });
  return async () => {
    // npx -> tsx -> node: signal the whole process group so no worker is orphaned.
    try {
      process.kill(-worker.pid!, "SIGTERM");
    } catch {
      // already exited
    }
  };
}
