import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

/**
 * The paths the milestone test does not take: a user with no consent record (created
 * through the API rather than the sign-up form) is asked to accept the terms, the dashboard
 * offers the setup questions until they are finished, and skipping them leaves a working account.
 */
test("a user who never accepted the terms is asked to, and can skip the setup questions", async ({ page }) => {
  const stamp = Date.now();
  const email = `onboard-${randomUUID().slice(0, 8)}@tenderos.test`;
  const password = `Pw-${randomUUID()}`;
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // No acceptance on record: nothing else opens until the terms are accepted.
  await page.waitForURL("**/legal/accept**");
  await expect(page.getByRole("heading", { name: "Review our terms" })).toBeVisible();
  await page.getByRole("button", { name: "Accept and continue" }).click();
  await expect(page.getByText(/tick the box/i)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /I accept the Terms of Service/ })).toBeFocused();
  await page.getByRole("checkbox", { name: /I accept the Terms of Service/ }).check();
  await page.getByRole("button", { name: "Accept and continue" }).click();

  await page.waitForURL("**/onboarding");
  await page.getByLabel("Company name").fill(`Skip Co ${stamp}`);
  await page.getByRole("button", { name: "Create organisation" }).click();

  // Leave the wizard unanswered: the dashboard keeps offering it.
  await page.waitForURL("**/onboarding/profile");
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Finish setting up/ })).toBeVisible();
  await page.getByRole("link", { name: /Finish setting up/ }).click();
  await page.waitForURL("**/onboarding/profile");

  // Skipping saves nothing and the account works.
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.waitForURL((u) => u.pathname === "/discover");
  await expect(page.getByRole("heading", { name: "Discover tenders" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /command centre/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /Finish setting up/ })).toHaveCount(0);
  await page.goto("/onboarding/profile");
  await page.waitForURL("**/company");
});
