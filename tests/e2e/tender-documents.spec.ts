import { expect, test } from "@playwright/test";
import { adminClient, createOrgOwner } from "./helpers/accounts";
import { signInThroughForm, streamed } from "./helpers/page";

/**
 * The Documents tab on a tender: what the portal lists, what happened to each file, why some are not read, and Retry. The
 * document links point at a host that never resolves (.invalid), so the real worker started for this run cannot reach
 * any network; what is checked is what the person sees and what pressing Retry asks the system to do. The fetch itself
 * is covered by tests/integration/tender-documents.test.ts.
 */
test("the Documents tab shows what happened to each document and lets a person retry a failed one", async ({ page }) => {
  const owner = await createOrgOwner({ emailPrefix: "docs" });
  const admin = adminClient();
  const link = (n: string) => `https://tenders.invalid/files/${n}.pdf`;
  const stamp = Date.now();

  const { data: tender, error } = await admin
    .from("tenders")
    .insert({
      organisation_id: owner.orgId,
      title: `Supply of road marking paint ${stamp}`,
      issuing_organisation: "Test Municipality",
      closing_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      province: "GAUTENG",
      submission_method: "ELECTRONIC_PORTAL",
      is_simulation: false,
      source_url: "https://tenders.invalid/notice/1",
      documents: [1, 2, 3, 4].map((n) => ({ name: `doc-${n}.pdf`, url: link(String(n)) })),
    })
    .select("id")
    .single();
  expect(error).toBeNull();

  const sha = "c".repeat(64);
  const rows = [
    {
      file_name: "Invitation to bid.pdf",
      source_url: link("1"),
      status: "DOWNLOADED",
      sha256: sha,
      size_bytes: 183_000,
      page_count: 4,
      storage_path: `${owner.orgId}/${tender!.id}/${sha}.pdf`,
      fetched_at: new Date().toISOString(),
    },
    {
      file_name: "Specification.docx",
      source_url: link("2"),
      status: "UNSUPPORTED",
      error: "A Word document is not read yet; only PDFs are. Open it on the portal and check it yourself",
    },
    { file_name: "Bill of quantities.pdf", source_url: link("3"), status: "FAILED", error: "The portal answered HTTP 503", attempts: 3 },
    { file_name: "Drawings.pdf", source_url: link("4"), status: "TOO_LARGE", error: "The file is larger than the 25 MB limit" },
  ].map((r) => ({ organisation_id: owner.orgId, tender_id: tender!.id, attempts: 0, ...r }));
  expect((await admin.from("tender_documents").insert(rows)).error).toBeNull();

  await signInThroughForm(page, owner.email, owner.password);
  await page.waitForURL((u) => u.pathname === "/");
  await page.goto(`/tenders/${tender!.id}`);
  await streamed(page);
  await page.getByRole("tab", { name: "Documents" }).click();

  const panel = page.getByRole("region", { name: "Tender documents" });
  await expect(panel.getByText("1 of 4 fetched.")).toBeVisible();
  const row = (name: string) => panel.getByRole("row", { name: new RegExp(name) });
  await expect(row("Invitation to bid.pdf")).toContainText("Fetched");
  await expect(row("Invitation to bid.pdf")).toContainText("4 pages");
  await expect(row("Specification.docx")).toContainText("Not read yet");
  await expect(row("Specification.docx")).toContainText("A Word document is not read yet");
  await expect(row("Bill of quantities.pdf")).toContainText("Failed");
  await expect(row("Bill of quantities.pdf")).toContainText("HTTP 503");
  await expect(row("Drawings.pdf")).toContainText("Too large");
  // Only the failed one offers a retry, and it names the file for a screen reader.
  await expect(panel.getByRole("button", { name: /^Retry/ })).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Retry Bill of quantities.pdf" })).toBeVisible();

  await panel.getByRole("button", { name: "Retry Bill of quantities.pdf" }).click();
  await expect
    .poll(async () => {
      const { data } = await admin.from("audit_logs").select("action").eq("organisation_id", owner.orgId).eq("action", "tender.documents_fetch_requested");
      return data?.length ?? 0;
    })
    .toBe(1);
  // The fetch was asked for (the worker's attempt then fails to find the host); the page says what happened, not that it worked.
  await expect(row("Bill of quantities.pdf")).toContainText(/Waiting to be fetched|Failed/);
  await expect(row("Invitation to bid.pdf")).toContainText("Fetched");
});
