import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { DOCUMENT_BUCKET } from "../../lib/domain/documents";
import { adminClient, createOrgOwner } from "./helpers/accounts";
import { signInThroughForm, streamed } from "./helpers/page";

/**
 * Editing the bid, end to end: a real tender is sent to the agents (rules only, as for an organisation without AI assistance),
 * reaches the approval gate with a proposal nobody has written and a schedule nobody has priced; a person writes and reviews a
 * section, adds a line, enters a price, confirms the schedule, prepares the bid again, and QA reads what they entered.
 * Money is worked out by the database: 2 x R1 500.50 is R3 001.00, VAT at 15% R450.15, R3 451.15 in all.
 */
test("a person edits a proposal section, prices the schedule and prepares the bid again, and QA reads their work", async ({ page }) => {
  const owner = await createOrgOwner({ emailPrefix: "bid" });
  const admin = adminClient();
  const stamp = Date.now();

  // A company that can pass compliance: a profile and the documents it needs, uploaded and verified by the owner.
  const asOwner = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  expect((await asOwner.auth.signInWithPassword({ email: owner.email, password: owner.password })).error).toBeNull();
  const expires = new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10);
  expect(
    (
      await admin.from("company_profiles").insert({
        organisation_id: owner.orgId,
        legal_name: "E2E Bid Trading (Pty) Ltd",
        registration_number: "2015/123456/07",
        csd_number: "MAAA0123456",
        tax_pin: "ABC123XYZ9",
        tax_pin_expires_at: expires,
        bbbee_level: 2,
        authorised_signatory: "A. Director",
      })
    ).error,
  ).toBeNull();
  for (const [type, expiry] of [
    ["cipc_registration", null],
    ["csd_registration", null],
    ["tax_compliance", expires],
    ["sbd_declarations", null],
    ["bbbee", expires],
  ] as const) {
    const path = `${owner.orgId}/${type}/doc.pdf`;
    expect((await asOwner.storage.from(DOCUMENT_BUCKET).upload(path, new Blob(["%PDF-1.4\n"], { type: "application/pdf" }))).error).toBeNull();
    expect((await asOwner.rpc("register_company_document", { p_org: owner.orgId, p_doc_type: type, p_title: type, p_path: path, p_expires_at: expiry as never })).error).toBeNull();
  }
  const { data: tender, error } = await admin
    .from("tenders")
    .insert({
      organisation_id: owner.orgId,
      title: `Rehabilitation of access roads ${stamp}`,
      issuing_organisation: "Test Municipality",
      closing_at: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      province: "GAUTENG",
      submission_method: "ELECTRONIC_PORTAL",
      is_simulation: false,
      reference_number: `E2E-BID-${stamp}`,
    })
    .select("id")
    .single();
  expect(error).toBeNull();

  await signInThroughForm(page, owner.email, owner.password);
  await page.waitForURL((u) => u.pathname === "/");
  await page.goto(`/tenders/${tender!.id}`);
  await streamed(page);
  const status = page.locator("#main").getByTestId("tender-status");
  await expect(status).toHaveText("Discovered");
  await page.getByRole("button", { name: "Send to the agents" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start", exact: true }).click();
  await expect(status).toHaveText("Ready for approval", { timeout: 120_000 });

  // The proposal: six sections nobody has written. A person writes one and reviews it.
  await page.getByRole("tab", { name: "Proposal" }).click();
  const proposal = page.getByRole("region", { name: "Proposal" });
  await expect(proposal.getByText("0 of 6 sections reviewed")).toBeVisible();
  await expect(proposal.getByText("Missing information")).toHaveCount(6);
  await proposal.getByLabel("Text of Methodology and approach").fill("We rehabilitate roads in three phases: survey, base layer and surfacing.");
  await proposal.getByRole("button", { name: "Save Methodology and approach" }).click();
  // The bid was waiting for approval: saving withdrew it and sent the bid back for preparation.
  await expect(status).toHaveText("Preparing bid", { timeout: 30_000 });
  await expect(proposal.getByText("Draft: not reviewed yet")).toBeVisible();
  await proposal.getByRole("button", { name: "Mark Methodology and approach as reviewed" }).click();
  await expect(proposal.getByText("1 of 6 sections reviewed")).toBeVisible();
  await expect(proposal.getByText(/Written by .*Reviewed by /)).toBeVisible();
  await proposal.getByText("History (3)").click();
  await expect(proposal.getByText(/Version 3: Reviewed by/)).toBeVisible();

  // The pricing: a banner that says who prices, no line yet, so the person adds one and types the figures.
  await page.getByRole("tab", { name: "Pricing" }).click();
  const pricing = page.getByRole("region", { name: "Pricing" });
  await expect(pricing.getByText("Prices are entered by a person.")).toBeVisible();
  await expect(pricing.getByText(/never produce a price, a rate or a total/)).toBeVisible();
  const add = pricing.getByRole("form", { name: "Add a line" });
  await add.getByLabel("Description").fill("Rehabilitate the access road");
  await add.getByLabel("Unit").fill("km");
  await add.getByLabel("Quantity").fill("2");
  await add.getByRole("button", { name: "Add line" }).click();
  await expect(pricing.getByText("Rehabilitate the access road")).toBeVisible();
  await expect(pricing.getByText("Not priced")).toBeVisible();
  await expect(pricing.getByRole("button", { name: "Confirm prices" })).toBeDisabled();
  await pricing.getByLabel("Unit price excluding VAT (R)").fill("1500.50");
  await pricing.getByLabel("Supplier quote reference").fill("Q-2026-14");
  await pricing.getByRole("button", { name: "Save line 1" }).click();
  const totals = pricing.getByLabel("Bid totals");
  await expect(totals).toContainText(/Subtotal excluding VAT\s*R\s3\s001\.00/);
  await expect(totals).toContainText(/VAT at 15%\s*R\s450\.15/);
  await expect(totals).toContainText(/Total including VAT\s*R\s3\s451\.15/);
  await pricing.getByRole("button", { name: "Confirm prices" }).click();
  await expect(pricing.getByText(/Confirmed by/)).toBeVisible();

  // Prepare the bid again: QA reads what the person wrote.
  await page.getByRole("button", { name: "Prepare bid again" }).click();
  await expect(status).toHaveText("Ready for approval", { timeout: 120_000 });
  await page.getByRole("tab", { name: "QA" }).click();
  await expect(page.getByText("Pricing completeness")).toBeVisible();
  await expect(page.getByText("5 sections need information")).toBeVisible();
  const qa = page.getByRole("tabpanel").filter({ hasText: "Pricing completeness" });
  await expect(qa.locator("li", { hasText: "Pricing completeness" })).toContainText("Priced");

  // The text and the figures are still there after the re-run, as the person left them.
  await page.getByRole("tab", { name: "Proposal" }).click();
  await expect(page.getByRole("region", { name: "Proposal" }).getByLabel("Text of Methodology and approach")).toHaveValue(/survey, base layer and surfacing/);
  await page.getByRole("tab", { name: "Pricing" }).click();
  await expect(page.getByRole("region", { name: "Pricing" }).getByLabel("Unit price excluding VAT (R)")).toHaveValue("1500.50");
});
