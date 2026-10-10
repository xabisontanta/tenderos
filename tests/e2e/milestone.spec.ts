import { expect, test } from "@playwright/test";

/**
 * The first milestone, driven through the browser: sign up, create an
 * organisation, create a simulated tender, run the workflow, watch agents hand
 * off through the pipeline, approve, and see the simulated submission recorded.
 */
/** Set E2E_SCREENSHOTS=<dir> to save full-page captures of each stage. */
const shotDir = process.env.E2E_SCREENSHOTS;
async function shot(page: import("@playwright/test").Page, name: string) {
  if (shotDir) await page.screenshot({ path: `${shotDir}/${name}.png`, fullPage: true });
}

test("simulated tender runs from creation to approved submission", async ({ page }) => {
  const stamp = Date.now();
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  await page.goto("/signup");
  await page.getByLabel("Full name").fill("E2E Operator");
  await page.getByLabel("Email").fill(`e2e-${stamp}@example.test`);
  await page.getByLabel("Password").fill(`Sup3r-secret-${stamp}`);
  await page.getByRole("button", { name: "Create account" }).click();

  await page.waitForURL("**/onboarding");
  await page.getByLabel("Company name").fill(`E2E Construction ${stamp}`);
  await page.getByRole("button", { name: "Create organisation" }).click();
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.getByRole("heading", { name: /dashboard|command/i }).first()).toBeVisible();

  // Office shows the persisted agent registry, all idle.
  await page.goto("/office");
  await expect(page.getByText("Tender Analyst").first()).toBeVisible();

  await page.goto("/tenders/new");
  await page.getByLabel("Title *").fill(`Supply of road maintenance materials ${stamp}`);
  await page.getByLabel("Issuing organisation *").fill("E2E Test Municipality");
  await page.getByLabel("Reference number").fill(`E2E-${stamp}`);
  await page.getByLabel("Sector").fill("Construction");
  await page.getByLabel("Scope / description").fill("Simulated tender for end-to-end testing.");
  const closing = new Date(Date.now() + 21 * 86_400_000 + 2 * 3_600_000);
  await page.getByLabel("Closing date and time *").fill(closing.toISOString().slice(0, 16));
  await page.getByRole("button", { name: /create tender/i }).click();

  await page.waitForURL(/\/tenders\/[0-9a-f-]{36}$/);
  const tenderUrl = page.url();
  await expect(page.locator("#main").getByTestId("tender-status")).toHaveText("Discovered");

  await page.getByRole("button", { name: "Start simulated workflow" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByText("Workflow started")).toBeVisible();
  if (shotDir) {
    await page.goto("/office");
    await page.waitForTimeout(4000);
    await shot(page, "2-office-running");
    await page.goto("/operations");
    await page.waitForTimeout(3000);
    await shot(page, "3-operations-running");
    await page.goto(tenderUrl);
  }

  // The workflow pauses at the human approval gate.
  const status = page.locator("#main").getByTestId("tender-status");
  await expect(status).toHaveText("Ready for approval", { timeout: 120_000 });

  await shot(page, "4-tender-awaiting-approval");
  await page.goto("/approvals");
  await shot(page, "5-approvals");
  await expect(page.getByRole("link", { name: new RegExp(`Supply of road maintenance materials ${stamp}`) })).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Approved/).first()).toBeVisible();

  await page.goto(tenderUrl);
  await expect(status).toHaveText("Submitted", { timeout: 60_000 });
  await expect(page.getByText("Human approval").first()).toBeVisible();
  await shot(page, "6-tender-submitted");

  // Operations view reflects the same persisted handoffs.
  await page.goto("/operations");
  await expect(page.getByText(/handoff/i).first()).toBeVisible();
  await page.goto("/");
  await shot(page, "1-dashboard-after-run");

  expect(consoleErrors.filter((e) => /Content Security Policy|Refused to/.test(e))).toEqual([]);
});
