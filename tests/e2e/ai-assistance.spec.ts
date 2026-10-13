import { expect, test } from "@playwright/test";
import { adminClient, createOrgOwner } from "./helpers/accounts";
import { signInThroughForm, streamed } from "./helpers/page";

/**
 * Settings, AI assistance (migration 070): an owner reads what is sent to Anthropic and what never is, cannot switch AI on
 * without ticking that they have read it, sets the daily budget, and switches it off again. What the engine then does with
 * the column is covered by tests/integration/ai-execution.test.ts.
 */
test("an owner switches AI assistance on only after the consent box, sets the budget and switches it off", async ({ page }) => {
  const owner = await createOrgOwner({ emailPrefix: "ai" });
  const read = async () => {
    const { data, error } = await adminClient()
      .from("system_settings")
      .select("ai_enabled, ai_web_research_enabled, daily_ai_budget_usd")
      .eq("organisation_id", owner.orgId)
      .single();
    expect(error).toBeNull();
    return data as { ai_enabled: boolean; ai_web_research_enabled: boolean; daily_ai_budget_usd: number };
  };

  await signInThroughForm(page, owner.email, owner.password);
  await page.waitForURL((u) => u.pathname === "/");
  await page.goto("/settings");
  await streamed(page);

  const card = page.getByRole("region", { name: /Use AI to help prepare bids/ });
  await expect(card).toBeVisible();
  // Plain words about what leaves the system, and what never does.
  await expect(card.getByRole("heading", { name: "What is sent to Anthropic" })).toBeVisible();
  await expect(card.getByText(/text of the tender documents/i)).toBeVisible();
  await expect(card.getByRole("heading", { name: "What is never sent" })).toBeVisible();
  await expect(card.getByText(/Directors' personal data/i)).toBeVisible();
  await expect(card.getByText(/Bank details/i).first()).toBeVisible();
  await expect(card.getByText(/^Proof of address\.$/)).toBeVisible();
  await expect(card.getByText(/outside South Africa/i).first()).toBeVisible();
  await expect(card.getByRole("link", { name: "privacy notice" })).toHaveAttribute("href", "/privacy");

  // Off to begin with, and the button waits for the consent box.
  expect((await read()).ai_enabled).toBe(false);
  const switchOn = card.getByRole("button", { name: "Switch on AI assistance" });
  await expect(switchOn).toBeDisabled();
  await card.getByRole("checkbox", { name: /I have read what is sent to Anthropic/ }).check();
  await expect(switchOn).toBeEnabled();
  await switchOn.click();
  await expect(card.getByRole("button", { name: "Switch off" })).toBeVisible();
  await expect.poll(async () => (await read()).ai_enabled).toBe(true);

  // The daily budget: dollars and cents, above zero, within the cap; the server says why when it is not.
  const budget = card.getByLabel("Daily budget (US dollars)");
  await budget.fill("0");
  await card.getByRole("button", { name: "Save budget" }).click();
  await expect(card.getByRole("alert")).toContainText(/above zero/i);
  await budget.fill("12.50");
  await card.getByRole("button", { name: "Save budget" }).click();
  await expect.poll(async () => Number((await read()).daily_ai_budget_usd)).toBe(12.5);
  await page.reload();
  await streamed(page);
  await expect(page.getByRole("region", { name: /Use AI to help prepare bids/ }).getByLabel("Daily budget (US dollars)")).toHaveValue("12.5");
  await expect(page.getByText("Spent today")).toBeVisible();

  // Switching off puts everything back; the consent box is asked for again next time.
  await page
    .getByRole("region", { name: /Use AI to help prepare bids/ })
    .getByRole("button", { name: "Switch off" })
    .click();
  await expect.poll(async () => (await read()).ai_enabled).toBe(false);
  await expect(page.getByRole("button", { name: "Switch on AI assistance" })).toBeDisabled();
});
