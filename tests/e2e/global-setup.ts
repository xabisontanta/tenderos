import { spawn, spawnSync } from "node:child_process";

const windows = process.platform === "win32";

/** Starts a real job worker for the duration of the run and stops it afterwards. */
export default async function globalSetup() {
  const url = process.env.DATABASE_URL ?? "";
  if (url && !/127\.0\.0\.1|localhost/.test(url)) throw new Error("E2E tests only run against a local database");
  // On Windows `npx` is npx.cmd, which Node only starts through a shell; elsewhere the worker
  // gets its own process group so the whole tree can be signalled at the end.
  const options = { stdio: ["ignore", "pipe", "inherit"] as ["ignore", "pipe", "inherit"], env: process.env, windowsHide: true };
  const worker = windows
    ? spawn("npx tsx scripts/worker.ts", { ...options, shell: true })
    : spawn("npx", ["tsx", "scripts/worker.ts"], { ...options, detached: true });
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
    // npx -> tsx -> node: stop the whole tree so no worker is orphaned.
    try {
      if (windows) spawnSync("taskkill", ["/pid", String(worker.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-worker.pid!, "SIGTERM");
    } catch {
      // already exited
    }
  };
}
