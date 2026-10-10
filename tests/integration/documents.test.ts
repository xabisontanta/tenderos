import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import type { Worker } from "@/workflows/worker";
import { DOCUMENT_BUCKET } from "@/lib/domain/documents";
import { addMember, bootstrapOrg, createTender, createUser, drainOrg, testPool, testWorker, type Client, type TestUser } from "./helpers";

let pool: Pool;
let worker: Worker;
let owner: TestUser;
let operator: TestUser;
let outsider: TestUser;
let orgId: string;

const pdf = () => new Blob(["%PDF-1.4\n% TenderOS test document\n"], { type: "application/pdf" });
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

async function upload(client: Client, path: string, docType: string, title: string, expiresAt?: string) {
  const up = await client.storage.from(DOCUMENT_BUCKET).upload(path, pdf(), { contentType: "application/pdf" });
  if (up.error) return { error: up.error };
  return client.rpc("register_company_document", { p_org: orgId, p_doc_type: docType, p_title: title, p_path: path, p_expires_at: expiresAt });
}

beforeAll(async () => {
  pool = testPool();
  worker = testWorker(pool);
  owner = await createUser("docs-owner");
  operator = await createUser("docs-operator");
  outsider = await createUser("docs-outsider");
  orgId = await bootstrapOrg(owner);
  await addMember(orgId, operator.id, "operator", pool);
  await bootstrapOrg(outsider);
});

afterAll(async () => {
  await pool.end();
});

describe("company document vault", () => {
  it("keeps each organisation's files private", async () => {
    const foreign = await upload(outsider.client, `${orgId}/x/cipc.pdf`, "cipc_registration", "Not mine");
    expect(foreign.error).not.toBeNull();
    const ok = await upload(owner.client, `${orgId}/a/cipc.pdf`, "cipc_registration", "CIPC CoR 14.3");
    expect(ok.error).toBeNull();
    const { data: seen } = await outsider.client.from("company_documents").select("id").eq("organisation_id", orgId);
    expect(seen).toEqual([]);
    const dl = await outsider.client.storage.from(DOCUMENT_BUCKET).download(`${orgId}/a/cipc.pdf`);
    expect(dl.error).not.toBeNull();
    const direct = await owner.client.from("company_documents").insert({} as never);
    expect(direct.error).not.toBeNull();
  });

  it("refuses a registration for a file that was never uploaded", async () => {
    const { error } = await owner.client.rpc("register_company_document", {
      p_org: orgId,
      p_doc_type: "csd_registration",
      p_title: "Ghost",
      p_path: `${orgId}/missing/csd.pdf`,
    });
    expect(error).not.toBeNull();
  });

  it("lets compliance rely only on verified uploads and lists them in the bid pack", async () => {
    // Operator uploads are unverified until an owner or admin verifies them.
    const csd = await upload(operator.client, `${orgId}/b/csd.pdf`, "csd_registration", "CSD summary report");
    expect(csd.error).toBeNull();
    expect((await upload(owner.client, `${orgId}/c/tcs.pdf`, "tax_compliance", "TCS PIN letter", inDays(200))).error).toBeNull();
    expect((await upload(owner.client, `${orgId}/d/sbd.pdf`, "sbd_declarations", "SBD forms")).error).toBeNull();
    expect((await upload(owner.client, `${orgId}/e/bank.pdf`, "bank_confirmation", "Bank letter")).error).toBeNull();

    const tender = await createTender(owner.client, orgId, { is_simulation: false, reference_number: `DOC-${Date.now()}` });
    const started = await owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    expect(started.error).toBeNull();
    await drainOrg(worker, pool, orgId);

    const { data: blocked } = await owner.client.from("tenders").select("status").eq("id", tender.id).single();
    expect(blocked!.status).toBe("MISSING_INFORMATION");

    const { data: unverified } = await owner.client.from("company_documents").select("id, verified").eq("storage_path", `${orgId}/b/csd.pdf`).single();
    expect(unverified!.verified).toBe(false);
    expect((await operator.client.rpc("verify_company_document", { p_id: unverified!.id })).error).not.toBeNull();
    expect((await owner.client.rpc("verify_company_document", { p_id: unverified!.id })).error).toBeNull();
    await drainOrg(worker, pool, orgId);

    const { data: run } = await owner.client.from("workflow_runs").select("id, status").eq("id", started.data!).single();
    expect(run!.status).toBe("WAITING_APPROVAL");
    const { data: compliance } = await owner.client
      .from("tasks")
      .select("output")
      .eq("workflow_run_id", run!.id)
      .eq("type", "compliance.check")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    const items = (compliance!.output as { items: Array<{ key: string; status: string; document_id?: string | null; evidence: string }> }).items;
    const cipc = items.find((i) => i.key === "cipc_registration")!;
    expect(cipc.status).toBe("VALID");
    expect(cipc.evidence).toContain("CIPC CoR 14.3");
    expect(cipc.document_id).toBeTruthy();
    // POPIA: the Compliance Officer never receives the bank letter.
    expect(JSON.stringify(compliance!.output)).not.toContain("Bank letter");

    const { data: approval } = await owner.client.from("approvals").select("id").eq("workflow_run_id", run!.id).single();
    expect((await owner.client.rpc("decide_approval", { p_approval_id: approval!.id, p_approve: true, p_comments: "ok" })).error).toBeNull();
    await drainOrg(worker, pool, orgId);
    const { data: submission } = await owner.client.from("tasks").select("output").eq("workflow_run_id", run!.id).eq("type", "submission.execute").single();
    const out = submission!.output as { attachments: Array<{ key: string }>; receipt_note: string };
    expect(out.attachments.map((a) => a.key).sort()).toEqual(["cipc_registration", "csd_registration", "sbd_declarations", "tax_compliance"]);
    expect(out.receipt_note).toMatch(/Include the 4 company documents/);
  });

  it("archived documents stop counting", async () => {
    const { data: doc } = await owner.client.from("company_documents").select("id").eq("storage_path", `${orgId}/a/cipc.pdf`).single();
    expect((await operator.client.rpc("archive_company_document", { p_id: doc!.id })).error).not.toBeNull();
    expect((await owner.client.rpc("archive_company_document", { p_id: doc!.id })).error).toBeNull();
    const { rows } = await pool.query(`select archived_at is not null as archived from public.company_documents where id = $1`, [doc!.id]);
    expect(rows[0].archived).toBe(true);
    const { rows: audit } = await pool.query(`select count(*)::int as n from public.audit_logs where organisation_id = $1 and action like '%document%'`, [
      orgId,
    ]);
    expect(audit[0].n).toBeGreaterThanOrEqual(6);
  });
});
