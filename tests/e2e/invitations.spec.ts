import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { registryPayload } from "../../lib/org/bootstrap";
import { LEGAL_VERSIONS } from "../../lib/legal/versions";
import { pickLink, waitForMail } from "./helpers/mailbox";

/**
 * Team invitations, end to end: an owner invites an auditor as a read-only viewer from Settings, the auditor
 * opens the link in a browser with no session, creates an account with the invited address, confirms it, joins
 * the client's organisation from the onboarding page, and sees it, read-only.
 *
 * This run has no SMTP server (a production build with MAIL_FROM unset), which is the "email could not be sent"
 * path: the invitation exists and the link is shown to the inviter once, so that is what the test follows.
 * The email itself is covered by unit tests with a fake transport.
 */
test("an owner invites an auditor, who creates an account, joins and sees the organisation read-only", async ({ page, browser }) => {
  const stamp = Date.now();
  const orgName = `Khumalo Civils ${stamp}`;
  const ownerEmail = `owner-${randomUUID().slice(0, 8)}@tenderos.test`;
  const ownerPassword = `Pw-${randomUUID()}`;
  const auditorEmail = `auditor-${randomUUID().slice(0, 8)}@tenderos.test`;
  const auditorPassword = `Sup3r-secret-${stamp}`;

  // The owner: an organisation that exists, with the terms accepted (set up through the API, not the form).
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const created = await admin.auth.admin.createUser({
    email: ownerEmail,
    password: ownerPassword,
    email_confirm: true,
    user_metadata: { full_name: "Sipho Dlamini" },
  });
  if (created.error) throw created.error;
  const asOwner = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  expect((await asOwner.auth.signInWithPassword({ email: ownerEmail, password: ownerPassword })).error).toBeNull();
  expect((await asOwner.rpc("accept_legal", { p_terms_version: LEGAL_VERSIONS.terms, p_privacy_version: LEGAL_VERSIONS.privacy })).error).toBeNull();
  const boot = await admin.rpc("bootstrap_organisation", {
    p_user_id: created.data.user.id,
    p_name: orgName,
    p_slug: `e2e-${randomUUID().slice(0, 12)}`,
    ...registryPayload(),
  } as never);
  expect(boot.error).toBeNull();

  // The owner invites the auditor as a viewer.
  await page.goto("/login");
  await page.getByLabel("Email").fill(ownerEmail);
  await page.getByLabel("Password").fill(ownerPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => u.pathname === "/");
  await page.goto("/settings");
  await streamed(page);
  await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();
  await page.getByLabel("Invite by email").fill(auditorEmail);
  await expect(page.getByLabel("Role", { exact: true })).toHaveValue("viewer");
  await page.getByRole("button", { name: "Send invitation" }).click();

  const section = page.getByRole("region", { name: "New invitation" });
  await expect(section).toBeVisible();
  // The email cannot go out in this run (a production build served over local http has no https link to put in it, and
  // there is no mail server); the page says so and still hands over the link.
  await expect(section.getByRole("status")).toContainText(/could not be (prepared|sent)|no mail set up|not set up/i);
  const link = await section.getByLabel("Invitation link").inputValue();
  expect(link).toMatch(/\/invite\/tinv_[a-f0-9]{64}$/);
  // The pending list shows it with its expiry.
  await expect(page.getByRole("rowheader", { name: auditorEmail })).toBeVisible();
  const pending = page.getByRole("row", { name: new RegExp(auditorEmail) });
  await expect(pending).toContainText("Viewer");

  // The auditor: a browser with no session opens the link.
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const auditor = await context.newPage();
  const consoleErrors: string[] = [];
  auditor.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  await auditor.goto(new URL(link).pathname);
  await auditor.waitForURL((u) => u.pathname === "/invite");
  // The token is gone from the address bar, and the page names the organisation, the role and the address.
  expect(auditor.url()).not.toContain("tinv_");
  await expect(auditor.getByRole("heading", { name: `Join ${orgName}` })).toBeVisible();
  await expect(auditor.getByText(auditorEmail)).toBeVisible();
  await expect(auditor.getByText(/read-only: auditors and accountants/i)).toBeVisible();
  // Both ways in are always offered, whether or not the address has an account.
  await expect(auditor.getByRole("link", { name: "Sign in" })).toBeVisible();

  await auditor.getByRole("link", { name: "Create an account" }).click();
  await auditor.waitForURL("**/signup");
  await auditor.getByLabel("Full name").fill("Thandi Auditor");
  await auditor.getByLabel("Email").fill(auditorEmail);
  await auditor.getByLabel("Password").fill(auditorPassword);
  await auditor.getByRole("checkbox", { name: /I agree to the Terms of Service/ }).check();
  await auditor.getByRole("button", { name: "Create account" }).click();
  await confirmEmail(auditor, auditorEmail);

  // Signed in with no organisation, and an invitation in the cookie: the page offers to join, not to create.
  await auditor.waitForURL("**/onboarding");
  await expect(auditor.getByRole("heading", { name: `Join ${orgName}` })).toBeVisible();
  await expect(auditor.getByLabel("Company name")).toHaveCount(0);
  await auditor.getByRole("button", { name: `Join ${orgName}` }).click();
  await auditor.waitForURL((u) => u.pathname === "/");

  // They are in, as a viewer: they see the organisation and the team, and have no controls to change it.
  await auditor.goto("/settings");
  await streamed(auditor);
  await expect(auditor.getByText(orgName).first()).toBeVisible();
  await expect(auditor.getByRole("heading", { name: "Team" })).toBeVisible();
  await expect(auditor.getByRole("rowheader", { name: /Sipho Dlamini/ })).toBeVisible();
  await expect(auditor.getByRole("rowheader", { name: /Thandi Auditor/ })).toBeVisible();
  await expect(auditor.getByLabel("Invite by email")).toHaveCount(0);
  await expect(auditor.getByLabel("Role of Sipho Dlamini")).toHaveCount(0);
  // Viewers do not see anyone's address.
  await expect(auditor.getByText(ownerEmail)).toHaveCount(0);
  // The invitation is used up: its link no longer works.
  await auditor.goto(new URL(link).pathname);
  await auditor.waitForURL((u) => u.pathname === "/invite");
  await expect(auditor.getByRole("heading", { name: "This invitation link did not work" })).toBeVisible();
  expect(consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e))).toEqual([]);
  await context.close();

  // The owner sees the new member, with the address, and no pending invitation.
  await page.reload();
  await streamed(page);
  await expect(page.getByRole("rowheader", { name: /Thandi Auditor/ })).toContainText(auditorEmail);
  await expect(page.getByText("No pending invitations.")).toBeVisible();
});

/**
 * Waits for the streamed page to finish. While a page streams in, React keeps the finished content in a hidden
 * segment (id S:n) next to the loading skeleton, so a label can briefly exist twice and a strict locator refuses.
 */
async function streamed(page: Page) {
  await page.waitForFunction(() => document.querySelectorAll('[hidden][id^="S:"]').length === 0);
}

/** Follows the confirmation email when this stack has confirmations on; a stack without them signed the person in already. */
async function confirmEmail(page: Page, email: string) {
  const checkEmail = page.getByText(/check your email to confirm/i);
  await Promise.race([page.waitForURL("**/onboarding"), checkEmail.waitFor()]);
  if (page.url().endsWith("/onboarding")) return;
  const mail = await waitForMail(email, { subject: /confirm/i });
  const link = pickLink(mail, /\/auth\/(v1\/verify|confirm)/);
  await page.goto(new URL(link).pathname.startsWith("/auth/confirm") ? pickLink(mail, /\/auth\/confirm/, { origin: page.url() }) : link);
}
