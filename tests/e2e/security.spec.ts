import { expect, test, type Page } from "@playwright/test";
import { totp } from "../support/totp";
import { adminClient, createOrgOwner, totpEnabled } from "./helpers/accounts";
import { signInThroughForm, streamed } from "./helpers/page";

/**
 * Settings, Security and the second step of signing in. The first test needs nothing from the Auth server beyond
 * what every stack has; the second needs TOTP switched on in the Auth container (supabase/config.toml enables it, but a
 * container made from an older config has it off, and a restart does not change that) and skips itself otherwise.
 */
test("Security shows the set-up form, /mfa has nothing to check yet, and a start that cannot work says why", async ({ page }) => {
  const owner = await createOrgOwner({ emailPrefix: "sec" });
  await signInThroughForm(page, owner.email, owner.password);
  await page.waitForURL((u) => u.pathname === "/");

  await page.goto("/settings");
  await streamed(page);
  const card = page.locator("#security");
  await expect(card.getByRole("heading", { name: "Security" })).toBeVisible();
  await expect(card.getByText("Not set up")).toBeVisible();
  await expect(card.getByRole("heading", { name: "If you lose your phone" })).toBeVisible();
  await expect(card.getByText(/There are no backup codes/)).toBeVisible();

  // A person with no authenticator who opens the challenge page is told so, rather than shown a form that cannot work.
  await page.goto("/mfa");
  await expect(page.getByRole("heading", { name: "Verify it is you" })).toBeVisible();
  await expect(page.getByText("No authenticator app set up")).toBeVisible();
  await expect(page.getByRole("link", { name: "Set up an authenticator app" })).toHaveAttribute("href", "/settings#security");
  await expect(page.getByLabel("Code from your authenticator app")).toHaveCount(0);

  // Starting either draws the QR code (TOTP is on) or says plainly that the server has authenticators switched off.
  await page.goto("/settings");
  await streamed(page);
  await page.locator("#security").getByLabel("Set up an authenticator app").fill("My phone");
  await page.locator("#security").getByRole("button", { name: "Start" }).click();
  const qr = page.getByRole("img", { name: /QR code to add TenderOS/ });
  // (The refusal shows twice, inline and as a toast; the inline one is the one that stays.)
  const off = page
    .locator("#security")
    .getByRole("alert")
    .filter({ hasText: /not switched on for this TenderOS server/ });
  await expect(qr.or(off)).toBeVisible();
});

/**
 * "Require MFA for everyone", from the point of view of an owner who has not set an authenticator up. The requirement is switched
 * on in the database (switching it on through the app needs a session that passed the challenge, which needs TOTP on the stack),
 * so this runs on any stack. It shows what a person actually meets: why, and where to go.
 */
test("with MFA required, an owner without an authenticator is told why a privileged action stopped, and where to go", async ({ page }) => {
  const owner = await createOrgOwner({ emailPrefix: "req" });
  const { error } = await adminClient().from("system_settings").update({ require_mfa: true }).eq("organisation_id", owner.orgId);
  expect(error).toBeNull();
  await signInThroughForm(page, owner.email, owner.password);
  await page.waitForURL((u) => u.pathname === "/");

  // A banner says what is missing, without the person having to hit a wall first.
  await expect(page.getByRole("status").filter({ hasText: /requires an authenticator app/ })).toBeVisible();

  // The owner's switch shows it as on, and explains.
  await page.goto("/settings");
  await streamed(page);
  const card = page.locator("#security");
  await expect(card.getByRole("heading", { name: /Require MFA for everyone/ })).toBeVisible();
  await expect(card.getByText("On", { exact: true }).last()).toBeVisible();
  await expect(card.getByRole("button", { name: "Switch off" })).toBeVisible();

  // A privileged action is refused by the database, shown in words, with a way to the challenge page.
  await page.getByRole("button", { name: "Engage kill switch" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByLabel(/Reason/).fill("Drill: checking the second factor");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  const toast = page.getByRole("region", { name: /Notifications/ });
  await expect(toast.getByText(/Verify with your authenticator to do this/)).toBeVisible();
  await expect(toast.getByRole("link", { name: "Verify now" })).toHaveAttribute("href", /^\/mfa\?next=%2Fsettings/);
  // (The kill switch's dialog stays open after a refusal, so the person can try again; close it to reach the link.)
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await toast.getByRole("link", { name: "Verify now" }).click();
  await page.waitForURL("**/mfa?next=%2Fsettings");
  await expect(page.getByText("No authenticator app set up")).toBeVisible();

  // The kill switch did not engage.
  const { data } = await adminClient().from("system_settings").select("kill_switch").eq("organisation_id", owner.orgId).single();
  expect(data!.kill_switch).toBe(false);
});

test("an authenticator app: set it up, be asked for the code at sign-in, and open the page with it", async ({ page }) => {
  test.skip(!(await totpEnabled()), "TOTP is off in this stack's Auth container; recreate it from supabase/config.toml (docs/auth.md)");
  const owner = await createOrgOwner({ emailPrefix: "totp" });
  await signInThroughForm(page, owner.email, owner.password);
  await page.waitForURL((u) => u.pathname === "/");

  // Set up: scan (here: read the key), enter the first code.
  await page.goto("/settings");
  await streamed(page);
  const card = page.locator("#security");
  await card.getByLabel("Set up an authenticator app").fill("My phone");
  await card.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("img", { name: /QR code to add TenderOS/ })).toBeVisible();
  await card.getByRole("button", { name: "Show the key" }).click();
  const secret = await card.getByLabel(/Cannot scan\?/).inputValue();
  expect(secret).toMatch(/^[A-Z2-7]+$/);
  await enterCode(card.getByLabel("Code from the app"), card.getByRole("button", { name: "Turn on" }), secret, page);
  await expect(page.getByText(/Your authenticator is on/)).toBeVisible();
  await expect(card.getByText("On", { exact: true })).toBeVisible();

  // A new sign-in is a password only: it is stopped at /mfa, and so is a page typed into the address bar.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login");
  await signInThroughForm(page, owner.email, owner.password);
  await page.waitForURL("**/mfa");
  await expect(page.getByRole("heading", { name: "Verify it is you" })).toBeVisible();
  await page.goto("/tenders");
  await page.waitForURL("**/mfa?next=%2Ftenders");

  // A wrong code is refused in words; the right one opens the page that was asked for.
  const code = page.getByLabel("Code from your authenticator app");
  await code.fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /code did not work/i })).toBeVisible();
  // (A form that came back with an error keeps showing it until the next answer, so start the next try on a fresh page.)
  await page.reload();
  await enterCode(code, page.getByRole("button", { name: "Verify" }), secret, page, { reloadAfterRefusal: true });
  await page.waitForURL((u) => u.pathname === "/tenders");
});

/** Types the current code (or its neighbour, if the 30 second step turns over mid-click) until one is accepted. */
async function enterCode(
  input: ReturnType<Page["getByLabel"]>,
  submit: ReturnType<Page["getByRole"]>,
  secret: string,
  page: Page,
  options: { reloadAfterRefusal?: boolean } = {},
) {
  for (const stepOffset of [0, -1, 1]) {
    await input.fill(totp(secret, { stepOffset }));
    await submit.click();
    const failed = await page
      .getByRole("alert")
      .filter({ hasText: /code did not work/i })
      .waitFor({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (!failed) return;
    if (options.reloadAfterRefusal) await page.reload();
  }
  throw new Error("The authenticator code was not accepted");
}
