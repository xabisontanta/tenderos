import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

/**
 * Emailed links must work in a browser that never asked for the email (a phone,
 * another profile): PKCE codes cannot, token_hash links can. Each test gets a
 * fresh browser context, so there is no code verifier to find.
 */
const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

async function userWithRecoveryHash() {
  const email = `links-${randomUUID().slice(0, 8)}@tenderos.test`;
  const { error } = await admin().auth.admin.createUser({ email, password: `Pw-${randomUUID()}`, email_confirm: true });
  if (error) throw error;
  const { data, error: linkError } = await admin().auth.admin.generateLink({ type: "recovery", email });
  if (linkError) throw linkError;
  return data.properties.hashed_token;
}

test("a reset link opens the new-password page in a browser that never asked for it", async ({ page }) => {
  const hash = await userWithRecoveryHash();
  await page.goto(`/auth/confirm?token_hash=${hash}&type=recovery`);
  await page.waitForURL("**/reset-password");
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  // The link signed the visitor in, so the new password can be saved.
  await expect(page.getByLabel("New password")).toBeVisible();
});

test("a link is good once", async ({ page, browser, baseURL }) => {
  const hash = await userWithRecoveryHash();
  await page.goto(`/auth/confirm?token_hash=${hash}&type=recovery`);
  await page.waitForURL("**/reset-password");

  const second = await browser.newContext({ baseURL });
  const again = await second.newPage();
  await again.goto(`/auth/confirm?token_hash=${hash}&type=recovery`);
  await again.waitForURL("**/login?error=link_invalid");
  await second.close();
});

test("a bad link lands on sign-in with an explanation", async ({ page }) => {
  await page.goto(`/auth/confirm?token_hash=${"0".repeat(64)}&type=recovery`);
  await page.waitForURL("**/login?error=link_invalid");
  // (not getByRole("alert") alone: Next.js has its own route announcer with that role)
  await expect(page.getByText(/expired or was already used/i)).toBeVisible();
});
