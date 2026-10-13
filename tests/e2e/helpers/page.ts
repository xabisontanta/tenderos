import type { Page } from "@playwright/test";

/**
 * Waits for a streamed page to finish. While a page streams in, React keeps the finished content in a hidden segment
 * (id S:n) next to the loading skeleton, so a label can briefly exist twice and a strict locator refuses.
 */
export async function streamed(page: Page) {
  await page.waitForFunction(() => document.querySelectorAll('[hidden][id^="S:"]').length === 0);
}

/** Signs in through the form. Lands wherever the app sends the person (the dashboard, or /mfa when they have an authenticator). */
export async function signInThroughForm(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
