import { chromium, type Browser, type LaunchOptions } from "@playwright/test";

/**
 * Launches a Chromium for the email asset and preview scripts. Order:
 * PLAYWRIGHT_CHROMIUM_PATH, Playwright's own Chromium, then an installed
 * Microsoft Edge or Google Chrome. Throws with what was tried when none starts.
 */
export async function launchBrowser(): Promise<Browser> {
  const attempts: Array<{ label: string; options: LaunchOptions }> = [];
  const custom = process.env.PLAYWRIGHT_CHROMIUM_PATH?.trim();
  if (custom) attempts.push({ label: `PLAYWRIGHT_CHROMIUM_PATH (${custom})`, options: { executablePath: custom } });
  attempts.push({ label: "bundled Chromium", options: {} });
  attempts.push({ label: "Microsoft Edge", options: { channel: "msedge" } });
  attempts.push({ label: "Google Chrome", options: { channel: "chrome" } });

  const failures: string[] = [];
  for (const { label, options } of attempts) {
    try {
      return await chromium.launch(options);
    } catch (err) {
      failures.push(`${label}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`Could not start a browser.\n${failures.join("\n")}\nInstall one with "npx playwright install chromium" or set PLAYWRIGHT_CHROMIUM_PATH.`);
}
