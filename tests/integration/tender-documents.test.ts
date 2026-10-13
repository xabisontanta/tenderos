import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@/lib/log";
import type { Pool } from "@/lib/db/pool";
import { Worker } from "@/workflows/worker";
import { createSupabaseStorage, TENDER_DOCUMENT_BUCKET } from "@/lib/tender-documents/storage";
import type { FetchRequest, FetchResult } from "@/lib/tender-documents/fetcher";
import { FakeAiClient, type FakeReply } from "../support/fake-ai";
import { makePdfBase64 } from "../eval/pdf";
import { etendersFetcher, etendersRow } from "../fixtures/etenders";
import { addMember, bootstrapOrg, createTender, createUser, drainOrg, futureIso, testPool, type TestUser } from "./helpers";

/**
 * Tender document ingestion (migration 071): the table, the private bucket, the "Fetch documents" RPC, the worker job with a
 * fake portal and the real local Storage, discovery queueing, and the Tender Analyst reading a stored PDF. The hardened
 * fetcher itself is covered by tests/unit/tender-document-fetcher.test.ts and was tried once against the live portal.
 */
let pool: Pool;
const storage = createSupabaseStorage(process.env);

const SOURCE = "https://www.etenders.gov.za/Home/opportunities?id=1";
const url = (name: string) => `https://www.etenders.gov.za/home/Download?blobName=${randomUUID()}.pdf&downloadedFileName=${encodeURIComponent(name)}`;

const pdfBytes = (...lines: string[]) => new Uint8Array(Buffer.from(makePdfBase64(lines.length ? lines : ["Rehabilitation of the access road"]), "base64"));
const docxBytes = () => new Uint8Array(Buffer.from("PK\x03\x04\x14\x00\x00\x00\x08\x00[Content_Types].xmlword/document.xmlPK\x05\x06\x00\x00", "latin1"));
const encryptedPdf = () =>
  new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< /Size 2 /Root 1 0 R /Encrypt 5 0 R >>\nstartxref\n0\n%%EOF\n", "latin1"));

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const good = (bytes: Uint8Array): FetchResult => ({ ok: true, bytes, sha256: sha(bytes), contentType: "application/pdf" });
const html = (): FetchResult => good(new Uint8Array(Buffer.from("<html><body>Please log in</body></html>")));
const failure = (reason: "http" | "network" | "too_large" | "timeout", message: string, retryable: boolean, status?: number): FetchResult => ({
  ok: false,
  reason,
  message,
  retryable,
  ...(status ? { status } : {}),
});

/** The portal as the worker sees it: answers by URL, remembers what was asked, and can change its mind. */
class FakePortal {
  readonly asked: FetchRequest[] = [];
  readonly answers = new Map<string, () => FetchResult>();
  answer(link: string, result: FetchResult | (() => FetchResult)) {
    this.answers.set(link, typeof result === "function" ? result : () => result);
  }
  fetch = async (req: FetchRequest): Promise<FetchResult> => {
    this.asked.push(req);
    const answer = this.answers.get(req.url);
    return answer ? answer() : failure("http", "The portal no longer has this file", false, 404);
  };
}

function worker(
  portal: FakePortal,
  extra: { ai?: ConstructorParameters<typeof Worker>[1]["ai"]; fetcher?: ConstructorParameters<typeof Worker>[1]["fetcher"] } = {},
) {
  return new Worker(pool, {
    concurrency: 1,
    simulationStepMs: 0,
    logger: createLogger({ service: "test" }, "error"),
    documents: { fetch: portal.fetch, storage },
    ...extra,
  });
}

interface Fixture {
  orgId: string;
  owner: TestUser;
  admin: TestUser;
  operator: TestUser;
  viewer: TestUser;
}

async function fixture(label: string): Promise<Fixture> {
  const [owner, adminUser, operator, viewer] = await Promise.all(["owner", "admin", "operator", "viewer"].map((r) => createUser(`${label}-${r}`)));
  const orgId = await bootstrapOrg(owner);
  await addMember(orgId, adminUser.id, "admin", pool);
  await addMember(orgId, operator.id, "operator", pool);
  await addMember(orgId, viewer.id, "viewer", pool);
  return { orgId, owner, admin: adminUser, operator, viewer };
}

const enableAi = (orgId: string) => pool.query(`update public.system_settings set ai_enabled = true where organisation_id = $1`, [orgId]);

async function realTender(f: Fixture, docs: Array<{ name: string; url: string }>, over: Record<string, unknown> = {}) {
  const tender = await createTender(f.owner.client, f.orgId, {
    is_simulation: false,
    reference_number: `TD-${randomUUID().slice(0, 8)}`,
    title: "Rehabilitation of the access road",
    province: "LIMPOPO",
    closing_at: futureIso(20),
    source_url: SOURCE,
    ...over,
  } as never);
  // Only discovery sets a tender's document links (browsers cannot write that column).
  await pool.query(`update public.tenders set documents = $2::jsonb where id = $1`, [tender.id, JSON.stringify(docs)]);
  return tender;
}

const rowsOf = async (tenderId: string) =>
  (
    await pool.query(
      `select id, file_name, status, error, sha256, size_bytes::int as size_bytes, page_count, storage_path, attempts, mime_type from public.tender_documents where tender_id = $1 order by created_at, file_name`,
      [tenderId],
    )
  ).rows as Array<{
    id: string;
    file_name: string;
    status: string;
    error: string | null;
    sha256: string | null;
    size_bytes: number | null;
    page_count: number | null;
    storage_path: string | null;
    attempts: number;
    mime_type: string | null;
  }>;

const jobsOf = async (orgId: string) =>
  (await pool.query(`select id, status, payload from public.jobs where organisation_id = $1 and kind = 'tender.documents.fetch' order by id`, [orgId])).rows;

beforeAll(() => {
  pool = testPool();
});

afterAll(async () => {
  await pool.end();
});

describe("fetch_tender_documents", () => {
  it("lists the documents the portal shows as PENDING and queues one fetch job", async () => {
    const f = await fixture("td-rpc");
    const tender = await realTender(f, [
      { name: "Invitation to bid.pdf", url: url("a") },
      { name: "Specification.pdf", url: url("b") },
      { name: "Not a link", url: "http://insecure.example.com/x.pdf" },
      { name: "", url: url("c") },
    ]);
    const { data, error } = await f.operator.client.rpc("fetch_tender_documents", { p_tender_id: tender.id });
    expect(error).toBeNull();
    expect(data).toBe(3);
    const rows = await rowsOf(tender.id);
    // (the link with no name is called "document"; the one that is not https was left out)
    expect(rows.map((r) => [r.file_name, r.status]).sort()).toEqual([
      ["Invitation to bid.pdf", "PENDING"],
      ["Specification.pdf", "PENDING"],
      ["document", "PENDING"],
    ]);
    expect(await jobsOf(f.orgId)).toHaveLength(1);

    // Pressing it again adds nothing and queues no second job while the first waits.
    expect((await f.operator.client.rpc("fetch_tender_documents", { p_tender_id: tender.id })).data).toBe(3);
    expect(await rowsOf(tender.id)).toHaveLength(3);
    expect(await jobsOf(f.orgId)).toHaveLength(1);
    const { rows: audit } = await pool.query(
      `select metadata from public.audit_logs where organisation_id = $1 and action = 'tender.documents_fetch_requested'`,
      [f.orgId],
    );
    expect(audit).toHaveLength(2);
  });

  it("is for owners, admins and operators, never viewers or other organisations", async () => {
    const f = await fixture("td-roles");
    const outsider = await createUser("td-roles-out");
    await bootstrapOrg(outsider);
    const tender = await realTender(f, [{ name: "A.pdf", url: url("a") }]);
    for (const user of [f.owner, f.admin, f.operator])
      expect((await user.client.rpc("fetch_tender_documents", { p_tender_id: tender.id })).error, user.email).toBeNull();
    for (const user of [f.viewer, outsider]) {
      expect((await user.client.rpc("fetch_tender_documents", { p_tender_id: tender.id })).error?.code, user.email).toBe("42501");
    }
    expect((await f.owner.client.rpc("fetch_tender_documents", { p_tender_id: randomUUID() })).error?.code).toBe("42501");
  });

  it("has nothing to fetch for a simulated tender, and says so", async () => {
    const f = await fixture("td-sim");
    const tender = await createTender(f.owner.client, f.orgId, { is_simulation: true });
    await pool.query(`update public.tenders set documents = $2::jsonb where id = $1`, [tender.id, JSON.stringify([{ name: "A.pdf", url: url("a") }])]);
    const { error } = await f.owner.client.rpc("fetch_tender_documents", { p_tender_id: tender.id });
    expect(error?.code).toBe("23514");
    expect(error?.message).toMatch(/simulated/i);
    expect(await rowsOf(tender.id)).toEqual([]);
  });

  it("refuses a document that is not on this tender", async () => {
    const f = await fixture("td-other");
    const a = await realTender(f, [{ name: "A.pdf", url: url("a") }]);
    const b = await realTender(f, [{ name: "B.pdf", url: url("b") }]);
    await f.owner.client.rpc("fetch_tender_documents", { p_tender_id: b.id });
    const [bRow] = await rowsOf(b.id);
    const { error } = await f.owner.client.rpc("fetch_tender_documents", { p_tender_id: a.id, p_document_id: bRow.id });
    expect(error?.code).toBe("23514");
  });
});

describe("the table and the bucket", () => {
  it("lets members read their organisation's rows and nobody else's, and nobody write", async () => {
    const f = await fixture("td-rls");
    const other = await fixture("td-rls-other");
    const mine = await realTender(f, [{ name: "A.pdf", url: url("a") }]);
    const theirs = await realTender(other, [{ name: "B.pdf", url: url("b") }]);
    await f.owner.client.rpc("fetch_tender_documents", { p_tender_id: mine.id });
    await other.owner.client.rpc("fetch_tender_documents", { p_tender_id: theirs.id });

    for (const user of [f.owner, f.viewer]) {
      const { data } = await user.client.from("tender_documents").select("tender_id");
      expect(
        data!.map((r) => r.tender_id),
        user.email,
      ).toEqual([mine.id]);
    }
    const [row] = await rowsOf(mine.id);
    expect(
      (
        await f.owner.client
          .from("tender_documents")
          .update({ status: "DOWNLOADED" } as never)
          .eq("id", row.id)
      ).error,
    ).not.toBeNull();
    expect((await f.owner.client.from("tender_documents").delete().eq("id", row.id)).error).not.toBeNull();
    expect(
      (
        await f.owner.client
          .from("tender_documents")
          .insert({ organisation_id: f.orgId, tender_id: mine.id, source_url: "https://www.etenders.gov.za/x", file_name: "x.pdf" } as never)
      ).error,
    ).not.toBeNull();
    expect((await rowsOf(mine.id))[0].status).toBe("PENDING");
  });

  it("will not point a row at another organisation's tender", async () => {
    const f = await fixture("td-fk");
    const other = await fixture("td-fk-other");
    const theirs = await realTender(other, []);
    await expect(
      pool.query(
        `insert into public.tender_documents (organisation_id, tender_id, source_url, file_name) values ($1, $2, 'https://www.etenders.gov.za/x', 'x.pdf')`,
        [f.orgId, theirs.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps a row and a stored file together, and a hash unique within a tender", async () => {
    const f = await fixture("td-constraints");
    const tender = await realTender(f, [{ name: "A.pdf", url: url("a") }]);
    await f.owner.client.rpc("fetch_tender_documents", { p_tender_id: tender.id });
    const [row] = await rowsOf(tender.id);
    await expect(pool.query(`update public.tender_documents set status = 'DOWNLOADED' where id = $1`, [row.id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`update public.tender_documents set storage_path = 'x/y.pdf' where id = $1`, [row.id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`update public.tender_documents set status = 'NOPE' where id = $1`, [row.id])).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `insert into public.tender_documents (organisation_id, tender_id, source_url, file_name, sha256) values ($1, $2, 'https://www.etenders.gov.za/1', 'one.pdf', $3)`,
      [f.orgId, tender.id, "a".repeat(64)],
    );
    await expect(
      pool.query(
        `insert into public.tender_documents (organisation_id, tender_id, source_url, file_name, sha256) values ($1, $2, 'https://www.etenders.gov.za/2', 'two.pdf', $3)`,
        [f.orgId, tender.id, "a".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(
        `insert into public.tender_documents (organisation_id, tender_id, source_url, file_name) values ($1, $2, 'https://www.etenders.gov.za/1', 'again.pdf')`,
        [f.orgId, tender.id],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("is private: members read stored files, outsiders and anonymous callers cannot, and no browser can write", async () => {
    const f = await fixture("td-bucket");
    const outsider = await createUser("td-bucket-out");
    await bootstrapOrg(outsider);
    const portal = new FakePortal();
    const link = url("Invitation.pdf");
    portal.answer(link, good(pdfBytes()));
    const tender = await realTender(f, [{ name: "Invitation.pdf", url: link }]);
    await f.owner.client.rpc("fetch_tender_documents", { p_tender_id: tender.id });
    await drainOrg(worker(portal), pool, f.orgId);
    const [row] = await rowsOf(tender.id);
    expect(row.status).toBe("DOWNLOADED");

    for (const user of [f.owner, f.viewer]) {
      const got = await user.client.storage.from(TENDER_DOCUMENT_BUCKET).download(row.storage_path!);
      expect(got.error, user.email).toBeNull();
      expect(
        Buffer.from(await got.data!.arrayBuffer())
          .subarray(0, 5)
          .toString(),
      ).toBe("%PDF-");
    }
    expect((await outsider.client.storage.from(TENDER_DOCUMENT_BUCKET).download(row.storage_path!)).error).not.toBeNull();
    const anon = (await import("@supabase/supabase-js")).createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    expect((await anon.storage.from(TENDER_DOCUMENT_BUCKET).download(row.storage_path!)).error).not.toBeNull();
    // The public route does not exist for a private bucket.
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${TENDER_DOCUMENT_BUCKET}/${row.storage_path}`);
    expect(res.status).toBeGreaterThanOrEqual(400);

    // No browser, whatever its role, can add, replace or remove a file.
    const pdf = new Blob([pdfBytes() as BlobPart], { type: "application/pdf" });
    expect(
      (
        await f.owner.client.storage
          .from(TENDER_DOCUMENT_BUCKET)
          .upload(`${f.orgId}/${tender.id}/${"b".repeat(64)}.pdf`, pdf, { contentType: "application/pdf" })
      ).error,
    ).not.toBeNull();
    expect(
      (await f.owner.client.storage.from(TENDER_DOCUMENT_BUCKET).upload(row.storage_path!, pdf, { contentType: "application/pdf", upsert: true })).error,
    ).not.toBeNull();
    expect((await f.owner.client.storage.from(TENDER_DOCUMENT_BUCKET).remove([row.storage_path!])).data ?? []).toHaveLength(0);
    expect((await f.owner.client.storage.from(TENDER_DOCUMENT_BUCKET).download(row.storage_path!)).error).toBeNull();
  });

  it("stops a member reading a file whose row is not (or no longer) a downloaded document", async () => {
    const f = await fixture("td-bucket-row");
    const portal = new FakePortal();
    const link = url("Invitation.pdf");
    portal.answer(link, good(pdfBytes()));
    const tender = await realTender(f, [{ name: "Invitation.pdf", url: link }]);
    await f.owner.client.rpc("fetch_tender_documents", { p_tender_id: tender.id });
    await drainOrg(worker(portal), pool, f.orgId);
    const [row] = await rowsOf(tender.id);
    await pool.query(`update public.tender_documents set status = 'UNSUPPORTED', storage_path = null where id = $1`, [row.id]);
    expect((await f.owner.client.storage.from(TENDER_DOCUMENT_BUCKET).download(row.storage_path!)).error).not.toBeNull();
  });
});

describe("the fetch job", () => {
  it("downloads, checks and stores each document, and records what happened to every one", async () => {
    const f = await fixture("td-job");
    const portal = new FakePortal();
    const pdf = pdfBytes("Invitation to bid", "Closing 28 October");
    const links = {
      invitation: url("Invitation to bid.pdf"),
      spec: url("Specification.docx"),
      fake: url("Bill of quantities.pdf"),
      missing: url("Annexure.pdf"),
      big: url("Drawings.pdf"),
      encrypted: url("Protected.pdf"),
      dwg: url("Plan.dwg"),
      copy: url("Zz copy of invitation.pdf"),
    };
    portal.answer(links.invitation, good(pdf));
    portal.answer(links.spec, good(docxBytes()));
    portal.answer(links.fake, html());
    portal.answer(links.missing, failure("http", "The portal no longer has this file", false, 404));
    portal.answer(links.big, failure("too_large", "The file is larger than the 25 MB limit", false));
    portal.answer(links.encrypted, good(encryptedPdf()));
    portal.answer(links.dwg, good(pdfBytes("never fetched")));
    portal.answer(links.copy, good(pdf));
    const tender = await realTender(
      f,
      Object.entries(links).map(([key, link]) => ({ name: decodeURIComponent(new URL(link).searchParams.get("downloadedFileName") ?? key), url: link })),
    );
    expect((await f.owner.client.rpc("fetch_tender_documents", { p_tender_id: tender.id })).error).toBeNull();
    await drainOrg(worker(portal), pool, f.orgId);

    const rows = Object.fromEntries((await rowsOf(tender.id)).map((r) => [r.file_name, r]));
    expect(rows["Invitation to bid.pdf"]).toMatchObject({
      status: "DOWNLOADED",
      sha256: sha(pdf),
      size_bytes: pdf.length,
      page_count: 1,
      mime_type: "application/pdf",
      error: null,
    });
    expect(rows["Invitation to bid.pdf"].storage_path).toBe(`${f.orgId}/${tender.id}/${sha(pdf)}.pdf`);
    expect(rows["Specification.docx"]).toMatchObject({ status: "UNSUPPORTED", storage_path: null });
    expect(rows["Specification.docx"].error).toMatch(/Word document is not read yet/);
    expect(rows["Bill of quantities.pdf"]).toMatchObject({ status: "FAILED", storage_path: null });
    expect(rows["Bill of quantities.pdf"].error).toMatch(/not a PDF/i);
    expect(rows["Annexure.pdf"]).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(rows["Annexure.pdf"].error).toMatch(/no longer has this file/);
    expect(rows["Drawings.pdf"]).toMatchObject({ status: "TOO_LARGE" });
    expect(rows["Protected.pdf"]).toMatchObject({ status: "UNSUPPORTED" });
    expect(rows["Protected.pdf"].error).toMatch(/password/i);
    expect(rows["Plan.dwg"]).toMatchObject({ status: "UNSUPPORTED", storage_path: null });
    expect(portal.asked.some((r) => r.url === links.dwg)).toBe(false);
    expect(rows["Zz copy of invitation.pdf"]).toMatchObject({ status: "UNSUPPORTED", sha256: null });
    expect(rows["Zz copy of invitation.pdf"].error).toMatch(/Identical to "Invitation to bid.pdf"/);

    // What is stored is what was downloaded, and only PDFs are stored.
    const stored = await storage.get(rows["Invitation to bid.pdf"].storage_path!);
    expect(sha(stored)).toBe(sha(pdf));
    expect((await rowsOf(tender.id)).filter((r) => r.storage_path)).toHaveLength(1);

    // The fetcher was told whose documents these are and where they may come from.
    expect(portal.asked.every((r) => r.sourceUrl === SOURCE && r.allowedHosts.includes("www.etenders.gov.za"))).toBe(true);

    const { rows: events } = await pool.query(
      `select event_type, severity, summary, payload from public.agent_events where tender_id = $1 and event_type = 'TENDER_DOCUMENTS_FETCHED'`,
      [tender.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("WARNING");
    expect(events[0].payload).toMatchObject({ downloaded: 1, failed: 2, tooLarge: 1 });
    // The log line and the event never carry the link.
    expect(JSON.stringify(events)).not.toContain("blobName");
  });

  it("tries a transient failure again, gives up after three attempts, and lets a person retry it", async () => {
    const f = await fixture("td-retry");
    const portal = new FakePortal();
    const link = url("Invitation.pdf");
    portal.answer(link, failure("http", "The portal answered HTTP 503", true, 503));
    const tender = await realTender(f, [{ name: "Invitation.pdf", url: link }]);
    await f.operator.client.rpc("fetch_tender_documents", { p_tender_id: tender.id });
    await drainOrg(worker(portal), pool, f.orgId);
    let [row] = await rowsOf(tender.id);
    expect(row).toMatchObject({ status: "FAILED", attempts: 3 });
    expect(row.error).toMatch(/HTTP 503/);
    expect(portal.asked).toHaveLength(3);

    // The portal recovers; a person presses Retry on that one document.
    portal.answer(link, good(pdfBytes()));
    expect((await f.operator.client.rpc("fetch_tender_documents", { p_tender_id: tender.id, p_document_id: row.id })).data).toBe(1);
    await drainOrg(worker(portal), pool, f.orgId);
    [row] = await rowsOf(tender.id);
    expect(row).toMatchObject({ status: "DOWNLOADED", attempts: 1, error: null });
  });

  it("leaves a document it cannot find on the portal FAILED without trying again", async () => {
    const f = await fixture("td-404");
    const portal = new FakePortal();
    const tender = await realTender(f, [{ name: "Gone.pdf", url: url("Gone.pdf") }]);
    await f.owner.client.rpc("fetch_tender_documents", { p_tender_id: tender.id });
    await drainOrg(worker(portal), pool, f.orgId);
    expect(portal.asked).toHaveLength(1);
    expect((await rowsOf(tender.id))[0]).toMatchObject({ status: "FAILED", attempts: 1 });
  });

  it("does not fetch for a simulated tender even if a job somehow exists", async () => {
    const f = await fixture("td-simjob");
    const portal = new FakePortal();
    const tender = await createTender(f.owner.client, f.orgId, { is_simulation: true });
    await pool.query(`select private.enqueue_job($1, 'tender.documents.fetch', $2::jsonb, null)`, [f.orgId, JSON.stringify({ tender_id: tender.id })]);
    await drainOrg(worker(portal), pool, f.orgId);
    expect(portal.asked).toEqual([]);
  });

  it("fails the waiting documents with the reason when the job can never run", async () => {
    const f = await fixture("td-dead");
    const portal = new FakePortal();
    const link = url("Invitation.pdf");
    portal.answer(link, good(pdfBytes()));
    const tender = await realTender(f, [{ name: "Invitation.pdf", url: link }]);
    await f.owner.client.rpc("fetch_tender_documents", { p_tender_id: tender.id });
    // Storage is not configured for this worker: that is a setting to fix, not a file problem, and it must say so.
    const broken = new Worker(pool, {
      concurrency: 1,
      simulationStepMs: 0,
      logger: createLogger({ service: "test" }, "error"),
      documents: { fetch: portal.fetch, storage: createSupabaseStorage({ SUPABASE_URL: "http://127.0.0.1:1" }) },
    });
    await drainOrg(broken, pool, f.orgId);
    const [row] = await rowsOf(tender.id);
    expect(row.status).toBe("FAILED");
    expect(row.error).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe("discovery queues the fetch", () => {
  const feed = (documents: Array<{ supportDocumentID: string; fileName: string; extension: string }>, id = 910001) =>
    etendersFetcher([etendersRow({ id, tender_No: `DOC-${id}`, province: "Gauteng", supportDocument: documents })]).fetcher;

  async function scan(f: Fixture, fetcher: ReturnType<typeof feed>, portal: FakePortal) {
    expect((await f.owner.client.rpc("set_watched_provinces", { p_org: f.orgId, p_provinces: ["GAUTENG"], p_auto_run: false })).error).toBeNull();
    const { error } = await f.owner.client.rpc("start_discovery", { p_org: f.orgId });
    expect(error).toBeNull();
    await drainOrg(worker(portal, { fetcher }), pool, f.orgId);
  }

  it("does nothing for an organisation that has not switched AI assistance on", async () => {
    const f = await fixture("td-disc-off");
    const portal = new FakePortal();
    await scan(f, feed([{ supportDocumentID: "id-1", fileName: "Invitation.pdf", extension: ".pdf" }]), portal);
    const { rows } = await pool.query(`select count(*)::int as n from public.tenders where organisation_id = $1`, [f.orgId]);
    expect(rows[0].n).toBe(1);
    expect((await pool.query(`select count(*)::int as n from public.tender_documents where organisation_id = $1`, [f.orgId])).rows[0].n).toBe(0);
    expect(await jobsOf(f.orgId)).toEqual([]);
    expect(portal.asked).toEqual([]);
  });

  it("lists and fetches a new tender's documents when AI assistance is on, and picks up documents the portal adds later", async () => {
    const f = await fixture("td-disc-on");
    await enableAi(f.orgId);
    const portal = new FakePortal();
    const first = { supportDocumentID: "id-1", fileName: "Invitation.pdf", extension: ".pdf" };
    const link1 = `https://www.etenders.gov.za/home/Download?blobName=${encodeURIComponent("id-1.pdf")}&downloadedFileName=${encodeURIComponent("Invitation.pdf")}`;
    portal.answer(link1, good(pdfBytes("first")));
    await scan(f, feed([first]), portal);
    const { rows: tenders } = await pool.query(`select id from public.tenders where organisation_id = $1`, [f.orgId]);
    let rows = await rowsOf(tenders[0].id);
    expect(rows.map((r) => [r.file_name, r.status])).toEqual([["Invitation.pdf", "DOWNLOADED"]]);

    // The portal adds a document; the next scan refreshes the tender and fetches only the new one.
    const second = { supportDocumentID: "id-2", fileName: "Addendum 1.pdf", extension: ".pdf" };
    const link2 = `https://www.etenders.gov.za/home/Download?blobName=${encodeURIComponent("id-2.pdf")}&downloadedFileName=${encodeURIComponent("Addendum 1.pdf")}`;
    portal.answer(link2, good(pdfBytes("second")));
    await scan(f, feed([first, second]), portal);
    rows = await rowsOf(tenders[0].id);
    expect(rows.map((r) => [r.file_name, r.status])).toEqual([
      ["Invitation.pdf", "DOWNLOADED"],
      ["Addendum 1.pdf", "DOWNLOADED"],
    ]);
    expect(portal.asked.filter((r) => r.url === link1)).toHaveLength(1);
  });
});

describe("the Tender Analyst reads the stored PDFs", () => {
  const AI_ENV = {
    AI_ENABLED: "true",
    ANTHROPIC_API_KEY: "test-key-not-real",
    AI_MODEL_LOW: "model-low",
    AI_MODEL_MID: "model-mid",
    AI_MODEL_HIGH: "model-high",
    AI_PRICE_LOW: "0.1/0.5",
    AI_PRICE_MID: "2/10",
    AI_PRICE_HIGH: "4/20",
  };
  const textOf = (req: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }) =>
    req.messages
      .flatMap((m) => m.content)
      .map((b) => b.text ?? "")
      .join("\n");

  /** A model that reads the PDF's id from its marker and cites it; it declines every other step. */
  const model = () =>
    new FakeAiClient((req): FakeReply => {
      if (req.label !== "analysis.extract") return { text: "I can't help with that.", stopReason: "refusal", stopCategory: "other" };
      const id = /<<<UNTRUSTED_DATA kind="tender_document_pdf" id="([^"]*)"/.exec(textOf(req))?.[1];
      const items = id
        ? [
            {
              category: "SCOPE",
              text: "Rehabilitate the access road",
              mandatory: true,
              document_id: id,
              page: 1,
              section: "",
              quote: "Rehabilitation of the access road",
              date_iso: null,
              date_kind: "NONE",
            },
          ]
        : [];
      return { json: { items, gaps: [] }, usage: { inputTokens: 3000, outputTokens: 500 } };
    });

  async function runAnalysis(f: Fixture, portal: FakePortal, client: FakeAiClient, tenderId: string) {
    const { data: runId, error } = await f.owner.client.rpc("start_tender_workflow", { p_tender_id: tenderId });
    expect(error).toBeNull();
    await drainOrg(worker(portal, { ai: { env: AI_ENV, client } }), pool, f.orgId);
    const { rows } = await pool.query(`select output, status from public.tasks where workflow_run_id = $1 and step_key = 'analysis'`, [runId]);
    return rows[0] as {
      output: {
        requirements: Array<{ source: { kind: string; document_id?: string; quote_verified?: boolean } }>;
        gaps: string[];
        documents_analysed: number;
        ai_generated: boolean;
      };
      status: string;
    };
  }

  it("fetches what is still pending, sends the PDF as a document block, and counts it as analysed", async () => {
    const f = await fixture("td-analyst");
    await enableAi(f.orgId);
    const portal = new FakePortal();
    const pdf = pdfBytes("Rehabilitation of the access road", "Bidders must be CIDB registered");
    const links = { inv: url("Invitation to bid.pdf"), word: url("Specification.docx") };
    portal.answer(links.inv, good(pdf));
    portal.answer(links.word, good(docxBytes()));
    const tender = await realTender(f, [
      { name: "Invitation to bid.pdf", url: links.inv },
      { name: "Specification.docx", url: links.word },
    ]);
    const client = model();
    const analysis = await runAnalysis(f, portal, client, tender.id);

    expect(analysis.status).toBe("COMPLETED");
    expect(analysis.output).toMatchObject({ documents_analysed: 1, ai_generated: true });
    const [pdfRow] = (await rowsOf(tender.id)).filter((r) => r.status === "DOWNLOADED");
    const fromDocument = analysis.output.requirements.filter((r) => r.source.kind === "TENDER_DOCUMENT");
    expect(fromDocument).toHaveLength(1);
    expect(fromDocument[0].source).toMatchObject({ document_id: pdfRow.id, quote_verified: false });
    // The word file is reported, not silently dropped.
    expect(analysis.output.gaps.join("\n")).toMatch(/"Specification.docx" was not read: A Word document is not read yet/);

    const analysisCalls = client.requests.filter((r) => r.label === "analysis.extract");
    expect(analysisCalls).toHaveLength(1);
    const blocks = analysisCalls[0].messages.flatMap((m) => m.content);
    const sent = blocks.filter((b) => b.type === "pdf") as Array<{ type: "pdf"; base64: string }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].base64).toBe(Buffer.from(pdf).toString("base64"));
    // Nothing about the company or the people behind it is in what the model was shown.
    expect(textOf(analysisCalls[0])).not.toMatch(/director|bank|proof of address/i);
  });

  it("reads documents that were fetched earlier without fetching them again", async () => {
    const f = await fixture("td-analyst-cached");
    await enableAi(f.orgId);
    const portal = new FakePortal();
    const link = url("Invitation to bid.pdf");
    portal.answer(link, good(pdfBytes()));
    const tender = await realTender(f, [{ name: "Invitation to bid.pdf", url: link }]);
    await f.owner.client.rpc("fetch_tender_documents", { p_tender_id: tender.id });
    await drainOrg(worker(portal), pool, f.orgId);
    expect(portal.asked).toHaveLength(1);
    const analysis = await runAnalysis(f, portal, model(), tender.id);
    expect(analysis.output.documents_analysed).toBe(1);
    expect(portal.asked).toHaveLength(1);
  });

  it("sends nothing to the model, and fetches nothing, when the organisation has not switched AI assistance on", async () => {
    const f = await fixture("td-analyst-off");
    const portal = new FakePortal();
    const link = url("Invitation to bid.pdf");
    portal.answer(link, good(pdfBytes()));
    const tender = await realTender(f, [{ name: "Invitation to bid.pdf", url: link }]);
    // The documents are already stored: a person fetched them. That does not give the AI access to them.
    await f.owner.client.rpc("fetch_tender_documents", { p_tender_id: tender.id });
    await drainOrg(worker(portal), pool, f.orgId);
    const client = model();
    const analysis = await runAnalysis(f, portal, client, tender.id);
    expect(client.requests).toEqual([]);
    expect(client.countRequests).toEqual([]);
    expect(analysis.output.documents_analysed).toBe(0);
    expect(analysis.output.ai_generated).toBeFalsy();
  });

  it("reports a document it could not fetch, and still analyses the ones it could", async () => {
    const f = await fixture("td-analyst-partial");
    await enableAi(f.orgId);
    const portal = new FakePortal();
    const ok = url("Invitation to bid.pdf");
    const gone = url("Bill of quantities.pdf");
    portal.answer(ok, good(pdfBytes()));
    portal.answer(gone, failure("http", "The portal no longer has this file", false, 404));
    const tender = await realTender(f, [
      { name: "Invitation to bid.pdf", url: ok },
      { name: "Bill of quantities.pdf", url: gone },
    ]);
    const analysis = await runAnalysis(f, portal, model(), tender.id);
    expect(analysis.output.documents_analysed).toBe(1);
    expect(analysis.output.gaps.join("\n")).toMatch(/"Bill of quantities.pdf" could not be fetched: The portal no longer has this file/);
  });
});

describe("tenders with no documents", () => {
  it("are analysed from the record alone, with the gap stated", async () => {
    const f = await fixture("td-none");
    await enableAi(f.orgId);
    const client = new FakeAiClient(() => ({ text: "no", stopReason: "refusal", stopCategory: "other" }));
    const tender = await realTender(f, []);
    const { data: runId } = await f.owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    await drainOrg(
      new Worker(pool, {
        concurrency: 1,
        simulationStepMs: 0,
        logger: createLogger({ service: "test" }, "error"),
        ai: {
          env: { AI_ENABLED: "true", ANTHROPIC_API_KEY: "k", AI_MODEL_MID: "m", AI_MODEL_HIGH: "h", AI_PRICE_MID: "2/10", AI_PRICE_HIGH: "4/20" },
          client,
        },
        documents: { fetch: new FakePortal().fetch, storage },
      }),
      pool,
      f.orgId,
    );
    const { rows } = await pool.query(`select output from public.tasks where workflow_run_id = $1 and step_key = 'analysis'`, [runId]);
    expect(rows[0].output.documents_analysed).toBe(0);
    expect(rows[0].output.gaps.join("\n")).toMatch(/No tender documents were available/);
  });
});
