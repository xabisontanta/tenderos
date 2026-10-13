import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "@/lib/db/pool";
import { DOCUMENT_BUCKET } from "@/lib/domain/documents";
import { bidEditState } from "@/lib/domain/bid-content";
import { lineAmountCents, priceSchedule, vatCents } from "@/lib/domain/bid-money";
import { ALL_TENDER_STATUSES } from "@/lib/domain/tender-state";
import { loadBidContent, seedPricing, seedProposal } from "@/workflows/bid-content";
import { addMember, bootstrapOrg, createTender, createUser, drainOrg, futureIso, testPool, testWorker, type TestUser } from "./helpers";

/**
 * The bid content a person reviews and enters (migration 072): seeding from the agents' output, the edit and review functions,
 * the money arithmetic in the database, what an edit does to a bid waiting for approval, and QA reading what the person wrote.
 * Each test makes its own organisation (one organisation per user is enforced). Documents and mailboxes are not involved:
 * the runs are rules only, which is what an organisation without AI assistance gets.
 */
let pool: Pool;
const worker = () => testWorker(pool);

interface Fixture {
  orgId: string;
  owner: TestUser;
  admin: TestUser;
  operator: TestUser;
  viewer: TestUser;
}

async function fixture(label: string): Promise<Fixture> {
  const [owner, admin, operator, viewer] = await Promise.all(["owner", "admin", "operator", "viewer"].map((r) => createUser(`${label}-${r}`)));
  const orgId = await bootstrapOrg(owner);
  await addMember(orgId, admin.id, "admin", pool);
  await addMember(orgId, operator.id, "operator", pool);
  await addMember(orgId, viewer.id, "viewer", pool);
  return { orgId, owner, admin, operator, viewer };
}

/** A company profile and the four verified documents the compliance check needs, so a real bid can reach QA. */
async function readyCompany(f: Fixture): Promise<void> {
  const expires = new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10);
  const { error } = await f.owner.client.from("company_profiles").insert({
    organisation_id: f.orgId,
    legal_name: "Bid Content Test Trading (Pty) Ltd",
    registration_number: "2015/123456/07",
    csd_number: "MAAA0123456",
    tax_pin: "ABC123XYZ9",
    tax_pin_expires_at: expires,
    bbbee_level: 2,
    authorised_signatory: "A. Director",
  });
  expect(error).toBeNull();
  for (const [type, expiry] of [
    ["cipc_registration", undefined],
    ["csd_registration", undefined],
    ["tax_compliance", expires],
    ["sbd_declarations", undefined],
    ["bbbee", expires],
  ] as const) {
    const path = `${f.orgId}/${type}/doc.pdf`;
    expect((await f.owner.client.storage.from(DOCUMENT_BUCKET).upload(path, new Blob(["%PDF-1.4\n"], { type: "application/pdf" }))).error).toBeNull();
    const reg = await f.owner.client.rpc("register_company_document", { p_org: f.orgId, p_doc_type: type, p_title: type, p_path: path, p_expires_at: expiry });
    expect(reg.error).toBeNull();
  }
}

/** A real tender run to the approval gate with rules only: sections seeded, pricing structured, QA done, waiting for approval. */
async function readyBid(label: string) {
  const f = await fixture(label);
  await readyCompany(f);
  const tender = await createTender(f.owner.client, f.orgId, {
    is_simulation: false,
    reference_number: `BC-${randomUUID().slice(0, 8)}`,
    province: "LIMPOPO",
    closing_at: futureIso(20),
  });
  const { data: runId, error } = await f.owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
  expect(error).toBeNull();
  await drainOrg(worker(), pool, f.orgId);
  const status = await tenderStatus(tender.id);
  expect(status).toBe("READY_FOR_APPROVAL");
  return { f, tender, runId: runId as string };
}

const tenderStatus = async (id: string) => (await pool.query(`select status from public.tenders where id = $1`, [id])).rows[0].status as string;
const sectionsOf = async (tenderId: string) =>
  (await pool.query(`select * from public.bid_proposal_sections where tender_id = $1 order by position`, [tenderId])).rows as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const linesOf = async (tenderId: string) =>
  (
    await pool.query(
      `select id, position, version, source, description, quantity::float8 as quantity, quantity_printed, unit, unit_price_cents::float8 as unit_price_cents, supplier_quote_ref,
              amount_cents::float8 as amount_cents, vat_cents::float8 as vat_cents, requirement_id
         from public.bid_pricing_lines where tender_id = $1 order by position`,
      [tenderId],
    )
  ).rows as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const qaOutput = async (runId: string) =>
  (await pool.query(`select output from public.tasks where workflow_run_id = $1 and step_key = 'qa' and status = 'COMPLETED'`, [runId])).rows[0]?.output as {
    verdict: string;
    checks: Array<{ key: string; result: string; detail: string }>;
  };
const history = async (tenderId: string, kind: string, ref?: string) =>
  (await pool.query(`select version, change, changed_by, snapshot from public.bid_content_history where tender_id = $1 and kind = $2 ${ref ? "and ref = $3" : ""} order by id`, ref ? [tenderId, kind, ref] : [tenderId, kind]))
    .rows;
const auditActions = async (orgId: string, like: string) => (await pool.query(`select action, metadata from public.audit_logs where organisation_id = $1 and action like $2 order by id`, [orgId, like])).rows;

beforeAll(() => {
  pool = testPool();
});

afterAll(async () => {
  await pool.end();
});

describe("seeding from the agents", () => {
  it("lists the Proposal Writer's six sections and the pricing structure when a real run gets there", async () => {
    const { f, tender, runId } = await readyBid("bc-seed");
    const sections = await sectionsOf(tender.id);
    expect(sections.map((s) => s.section_key)).toEqual(["executive_summary", "methodology", "delivery_schedule", "staffing", "experience", "quality"]);
    // Rules only writes nothing: every section is missing information, with what a person would need.
    expect(sections.every((s) => s.status === "MISSING_INFORMATION" && s.content === null && s.version === 1 && s.ai_generated === false)).toBe(true);
    expect(sections[0].needs.length).toBeGreaterThan(0);
    const { rows: bid } = await pool.query(`select vat_treatment, confirmed_at from public.bid_pricing where tender_id = $1`, [tender.id]);
    expect(bid[0]).toEqual({ vat_treatment: "NOT_STATED", confirmed_at: null });
    expect((await history(tender.id, "PROPOSAL_SECTION", "methodology")).map((h) => h.change)).toEqual(["SEEDED"]);
    // QA found open issues, as it does for every bid nobody has written yet.
    const qa = await qaOutput(runId);
    expect(qa.verdict).toBe("CONDITIONAL");
    expect(qa.checks.find((c) => c.key === "technical")).toMatchObject({ result: "OPEN_ISSUE", detail: "6 sections need information" });
    expect(qa.checks.find((c) => c.key === "pricing")).toMatchObject({ result: "OPEN_ISSUE" });
    void f;
  });

  it("does not seed a simulated tender", async () => {
    const f = await fixture("bc-seed-sim");
    const tender = await createTender(f.owner.client, f.orgId, { is_simulation: true });
    await f.owner.client.rpc("start_tender_workflow", { p_tender_id: tender.id });
    await drainOrg(worker(), pool, f.orgId);
    expect(await sectionsOf(tender.id)).toEqual([]);
    expect((await pool.query(`select count(*)::int as n from public.bid_pricing where tender_id = $1`, [tender.id])).rows[0].n).toBe(0);
  });

  it("keeps the AI flag, the cited facts and requirements, and the warnings, and makes a drafted section a draft to review", async () => {
    const { f, tender } = await readyBid("bc-seed-ai");
    await pool.query(`delete from public.bid_proposal_sections where tender_id = $1`, [tender.id]);
    const client = await pool.connect();
    try {
      await seedProposal(client, {
        organisationId: f.orgId,
        tenderId: tender.id,
        taskId: (await pool.query(`select id from public.tasks where tender_id = $1 limit 1`, [tender.id])).rows[0].id,
        output: {
          ai_generated: true,
          simulated: false,
          open_items: 1,
          sections: [
            {
              key: "executive_summary",
              title: "Executive summary",
              status: "REQUIRES_CONFIRMATION",
              content: "We hold CIDB grade 6CE.",
              needs: [],
              paragraphs: [{ text: "We hold CIDB grade 6CE.", fact_ids: ["fact:cidb_grade"], requirement_ids: ["doc-1", "doc-2"] }],
              warnings: ["A paragraph was removed"],
            },
            { key: "methodology", title: "Methodology and approach", status: "MISSING_INFORMATION", content: null, needs: ["Company delivery methodology"] },
          ],
        },
      });
      const [a, b] = await sectionsOf(tender.id);
      expect(a).toMatchObject({ status: "DRAFT", ai_generated: true, content: "We hold CIDB grade 6CE.", fact_ids: ["fact:cidb_grade"], requirement_ids: ["doc-1", "doc-2"], warnings: ["A paragraph was removed"] });
      expect(b).toMatchObject({ status: "MISSING_INFORMATION", content: null, ai_generated: false, needs: ["Company delivery methodology"] });
      // QA reads an unreviewed AI draft as unconfirmed, not complete.
      const { proposal } = await loadBidContent(client, tender.id);
      expect(proposal!.sections[0]).toMatchObject({ status: "REQUIRES_CONFIRMATION" });
    } finally {
      client.release();
    }
  });
});

describe("editing a section", () => {
  it("lets an operator save text: theirs from then on, a new version, in the history and the audit trail, and the bid sent back", async () => {
    const { f, tender, runId } = await readyBid("bc-edit");
    const { data: version, error } = await f.operator.client.rpc("save_proposal_section", {
      p_tender_id: tender.id,
      p_key: "executive_summary",
      p_content: "  We build roads.\n\nSince 2011.  ",
      p_expected_version: 1,
    });
    expect(error).toBeNull();
    expect(version).toBe(2);
    const [s] = await sectionsOf(tender.id);
    expect(s).toMatchObject({ content: "We build roads.\n\nSince 2011.", status: "DRAFT", ai_generated: false, version: 2, edited_by: f.operator.id, reviewed_by: null });
    expect(s.edited_at).not.toBeNull();
    const h = await history(tender.id, "PROPOSAL_SECTION", "executive_summary");
    expect(h.map((x) => [x.version, x.change, x.changed_by])).toEqual([
      [1, "SEEDED", null],
      [2, "EDITED", f.operator.id],
    ]);
    const audit = await auditActions(f.orgId, "bid.section%");
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ section: "executive_summary", version: 2, characters: 28 });
    // The text itself is not copied into the audit trail.
    expect(JSON.stringify(audit)).not.toContain("We build roads");

    // The bid was waiting for approval: the approval is withdrawn and the bid goes back to preparation.
    expect(await tenderStatus(tender.id)).toBe("PREPARING_BID");
    const { rows: approvals } = await pool.query(`select status, comments from public.approvals where tender_id = $1`, [tender.id]);
    expect(approvals).toEqual([{ status: "CANCELLED", comments: "Withdrawn because the bid content was edited" }]);
    const { rows: runs } = await pool.query(`select status, outcome from public.workflow_runs where id = $1`, [runId]);
    expect(runs[0]).toEqual({ status: "CANCELLED", outcome: "BID_EDITED" });
    expect((await auditActions(f.orgId, "bid.approval_withdrawn"))).toHaveLength(1);
  });

  it("refuses a viewer and an outsider, and says nothing happened", async () => {
    const { f, tender } = await readyBid("bc-edit-roles");
    const outsider = await createUser("bc-edit-out");
    await bootstrapOrg(outsider);
    for (const user of [f.viewer, outsider]) {
      const { error } = await user.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: "methodology", p_content: "x", p_expected_version: 1 });
      expect(error?.code, user.email).toBe("42501");
    }
    for (const user of [f.owner, f.admin]) {
      expect((await user.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: user === f.owner ? "methodology" : "quality", p_content: "ok", p_expected_version: 1 })).error).toBeNull();
    }
    expect((await sectionsOf(tender.id)).filter((s) => s.edited_by).length).toBe(2);
  });

  it("refuses an out-of-date version, so two people cannot overwrite each other", async () => {
    const { f, tender } = await readyBid("bc-edit-version");
    expect((await f.operator.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: "methodology", p_content: "First.", p_expected_version: 1 })).error).toBeNull();
    const stale = await f.admin.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: "methodology", p_content: "Second.", p_expected_version: 1 });
    expect(stale.error?.message).toMatch(/changed by someone else/i);
    expect((await sectionsOf(tender.id))[1]).toMatchObject({ content: "First.", version: 2 });
  });

  it("leaves an unchanged section alone: no new version, and a bid waiting for approval keeps its approval", async () => {
    const { f, tender } = await readyBid("bc-edit-noop");
    const res = await f.operator.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: "methodology", p_content: "   ", p_expected_version: 1 });
    expect(res.error).toBeNull();
    expect(res.data).toBe(1);
    expect(await tenderStatus(tender.id)).toBe("READY_FOR_APPROVAL");
    expect((await history(tender.id, "PROPOSAL_SECTION", "methodology")).length).toBe(1);
  });

  it("makes a section with no text missing information again, and refuses text that is too long or for a section that does not exist", async () => {
    const { f, tender } = await readyBid("bc-edit-empty");
    const key = "quality";
    await f.operator.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: key, p_content: "Something.", p_expected_version: 1 });
    await f.operator.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: key, p_content: "\n \n", p_expected_version: 2 });
    expect((await sectionsOf(tender.id)).find((s) => s.section_key === key)).toMatchObject({ content: null, status: "MISSING_INFORMATION", version: 3, ai_generated: false });
    const long = await f.operator.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: key, p_content: "x".repeat(20001), p_expected_version: 3 });
    expect(long.error?.code).toBe("23514");
    const missing = await f.operator.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: "nope", p_content: "x", p_expected_version: 1 });
    expect(missing.error?.code).toBe("23514");
  });

  it("strips control characters", async () => {
    const { f, tender } = await readyBid("bc-edit-ctrl");
    await f.operator.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: "staffing", p_content: "Team\u0007 of\u001b[31m five", p_expected_version: 1 });
    expect((await sectionsOf(tender.id)).find((s) => s.section_key === "staffing")!.content).toBe("Team of[31m five");
  });
});

describe("reviewing a section", () => {
  it("records who reviewed it and when, and an edit after that takes the review away", async () => {
    const { f, tender } = await readyBid("bc-review");
    await f.operator.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: "methodology", p_content: "Our method.", p_expected_version: 1 });
    const reviewed = await f.admin.client.rpc("set_proposal_section_review", { p_tender_id: tender.id, p_key: "methodology", p_reviewed: true, p_expected_version: 2 });
    expect(reviewed.error).toBeNull();
    expect(reviewed.data).toBe(3);
    expect((await sectionsOf(tender.id))[1]).toMatchObject({ status: "REVIEWED", reviewed_by: f.admin.id, edited_by: f.operator.id, version: 3 });
    expect((await sectionsOf(tender.id))[1].reviewed_at).not.toBeNull();
    expect((await history(tender.id, "PROPOSAL_SECTION", "methodology")).map((h) => h.change)).toEqual(["SEEDED", "EDITED", "REVIEWED"]);
    expect((await auditActions(f.orgId, "bid.section_reviewed"))).toHaveLength(1);

    await f.operator.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: "methodology", p_content: "Our changed method.", p_expected_version: 3 });
    expect((await sectionsOf(tender.id))[1]).toMatchObject({ status: "DRAFT", reviewed_by: null, reviewed_at: null, version: 4 });
  });

  it("will not review a section with no text, review it twice, or take back a review that was never made", async () => {
    const { f, tender } = await readyBid("bc-review-rules");
    const empty = await f.owner.client.rpc("set_proposal_section_review", { p_tender_id: tender.id, p_key: "methodology", p_reviewed: true, p_expected_version: 1 });
    expect(empty.error?.code).toBe("23514");
    expect(empty.error?.message).toMatch(/needs text/i);
    await f.owner.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: "methodology", p_content: "Text.", p_expected_version: 1 });
    expect((await f.owner.client.rpc("set_proposal_section_review", { p_tender_id: tender.id, p_key: "methodology", p_reviewed: false, p_expected_version: 2 })).error?.code).toBe("23514");
    expect((await f.owner.client.rpc("set_proposal_section_review", { p_tender_id: tender.id, p_key: "methodology", p_reviewed: true, p_expected_version: 2 })).error).toBeNull();
    expect((await f.owner.client.rpc("set_proposal_section_review", { p_tender_id: tender.id, p_key: "methodology", p_reviewed: true, p_expected_version: 3 })).error?.code).toBe("23514");
    expect((await f.owner.client.rpc("set_proposal_section_review", { p_tender_id: tender.id, p_key: "methodology", p_reviewed: false, p_expected_version: 3 })).error).toBeNull();
    expect((await sectionsOf(tender.id))[1]).toMatchObject({ status: "DRAFT", reviewed_by: null });
  });

  it("is for owners, admins and operators", async () => {
    const { f, tender } = await readyBid("bc-review-roles");
    await f.owner.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: "methodology", p_content: "Text.", p_expected_version: 1 });
    expect((await f.viewer.client.rpc("set_proposal_section_review", { p_tender_id: tender.id, p_key: "methodology", p_reviewed: true, p_expected_version: 2 })).error?.code).toBe("42501");
    expect((await f.operator.client.rpc("set_proposal_section_review", { p_tender_id: tender.id, p_key: "methodology", p_reviewed: true, p_expected_version: 2 })).error).toBeNull();
  });
});

describe("when a bid can be edited", () => {
  it("agrees with the domain rule for every tender status", async () => {
    const { f, tender } = await readyBid("bc-gate");
    const outcomes: Record<string, string> = {};
    for (const status of ALL_TENDER_STATUSES) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local session_replication_role = replica");
        await client.query(`update public.tenders set status = $2 where id = $1`, [tender.id, status]);
        try {
          await client.query(`select private.prepare_bid_edit($1)`, [tender.id]);
          const { rows } = await client.query(`select status from public.tenders where id = $1`, [tender.id]);
          outcomes[status] = rows[0].status === status ? "editable" : "withdraws_approval";
        } catch (e) {
          outcomes[status] = (e as { code?: string }).code === "23514" ? "locked" : `error ${(e as Error).message}`;
        }
      } finally {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }
    }
    for (const status of ALL_TENDER_STATUSES) expect(outcomes[status], status).toBe(bidEditState(status));
    void f;
  });

  it("refuses an edit once the bid is approved, and says why", async () => {
    const { f, tender } = await readyBid("bc-locked");
    const { data: approval } = await f.owner.client.from("approvals").select("id").eq("tender_id", tender.id).single();
    expect((await f.owner.client.rpc("decide_approval", { p_approval_id: approval!.id, p_approve: true, p_comments: "ok" })).error).toBeNull();
    await drainOrg(worker(), pool, f.orgId);
    const res = await f.operator.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: "methodology", p_content: "Late change", p_expected_version: 1 });
    expect(res.error?.code).toBe("23514");
    expect(res.error?.message).toMatch(/approved or closed/i);
    const line = await f.operator.client.rpc("add_pricing_line", { p_tender_id: tender.id, p_description: "Late line", p_unit: "each", p_quantity: 1 });
    expect(line.error?.code).toBe("23514");
    expect((await sectionsOf(tender.id))[1].content).toBeNull();
  });

  it("refuses a simulated tender", async () => {
    const f = await fixture("bc-sim");
    const tender = await createTender(f.owner.client, f.orgId, { is_simulation: true });
    await pool.query(`insert into public.bid_proposal_sections (organisation_id, tender_id, section_key, title, status) values ($1, $2, 'methodology', 'Methodology', 'MISSING_INFORMATION')`, [f.orgId, tender.id]);
    const res = await f.owner.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: "methodology", p_content: "x", p_expected_version: 1 });
    expect(res.error?.code).toBe("23514");
    expect(res.error?.message).toMatch(/simulated/i);
  });
});

describe("pricing", () => {
  /** A seeded schedule line as the Pricing Analyst leaves it: the tender's printed quantity, no price. */
  async function tenderLine(f: Fixture, tenderId: string, over: { requirement?: string; quantity?: number | null; description?: string } = {}) {
    const { rows } = await pool.query(
      `insert into public.bid_pricing_lines (organisation_id, tender_id, position, source, description, unit, quantity, quantity_printed, requirement_id, quote, page)
       values ($1, $2, coalesce((select max(position) + 1 from public.bid_pricing_lines where tender_id = $2), 0), 'TENDER', $3, 'm', $4, $5, $6, '1.1 Supply 110 mm pipe 500 m', 4)
       returning id`,
      [f.orgId, tenderId, over.description ?? "Supply 110 mm pipe", over.quantity === undefined ? 500 : over.quantity, over.quantity !== null, over.requirement ?? "doc-1"],
    );
    return rows[0].id as string;
  }

  it("lets a person enter a unit price and a supplier quote reference, computes the amount and VAT in the database in cents, and clears nothing it should not", async () => {
    const { f, tender } = await readyBid("bc-price");
    const id = await tenderLine(f, tender.id);
    const saved = await f.operator.client.rpc("save_pricing_line", { p_line_id: id, p_unit_price_cents: 12345, p_quantity: 500, p_supplier_ref: "  Q-77 / Pipe Co  ", p_expected_version: 1 });
    expect(saved.error).toBeNull();
    expect(saved.data).toBe(2);
    const [l] = await linesOf(tender.id);
    expect(l).toMatchObject({ unit_price_cents: 12345, supplier_quote_ref: "Q-77 / Pipe Co", quantity: 500, amount_cents: 6_172_500, vat_cents: 925_875, version: 2 });
    const h = await history(tender.id, "PRICING_LINE", id);
    expect(h.map((x) => x.change)).toEqual(["FIGURES_ENTERED"]);
    expect(h[0].snapshot).toMatchObject({ unit_price_cents: 12345, amount_cents: 6_172_500 });
    const audit = await auditActions(f.orgId, "bid.price_entered");
    expect(audit[0].metadata).toMatchObject({ unit_price_cents: 12345, amount_cents: 6_172_500, has_supplier_quote: true });
    expect(await tenderStatus(tender.id)).toBe("PREPARING_BID");
  });

  it("computes exactly what the TypeScript arithmetic computes, for lines and for the bid", async () => {
    const { f, tender } = await readyBid("bc-parity");
    const cases: Array<[string, number]> = [
      ["1", 12345],
      ["1.5", 333],
      ["0.001", 499],
      ["0.001", 500],
      ["12.345", 10000],
      ["3", 0],
      ["0.5", 1],
      ["100", 435],
      ["999999.999", 1_000_000],
      ["7.125", 1],
      ["2", 333],
    ];
    for (const [i, [quantity, cents]] of cases.entries()) {
      const added = await f.owner.client.rpc("add_pricing_line", { p_tender_id: tender.id, p_description: `Line ${i + 1}`, p_unit: "each", p_quantity: Number(quantity) });
      expect(added.error, `add ${quantity}`).toBeNull();
      const saved = await f.owner.client.rpc("save_pricing_line", { p_line_id: added.data!, p_unit_price_cents: cents, p_quantity: Number(quantity), p_supplier_ref: null as never, p_expected_version: 1 });
      expect(saved.error, `price ${quantity} x ${cents}`).toBeNull();
    }
    const lines = await linesOf(tender.id);
    for (const [i, [quantity, cents]] of cases.entries()) {
      expect(lines[i].amount_cents, `${quantity} x ${cents}`).toBe(lineAmountCents(quantity, cents));
      expect(lines[i].vat_cents, `VAT on ${quantity} x ${cents}`).toBe(vatCents(lineAmountCents(quantity, cents)));
    }
    const ts = priceSchedule(cases.map(([quantity, cents]) => ({ quantity, unitPriceCents: cents })));
    const { data } = await f.viewer.client.rpc("bid_pricing_totals", { p_tender_id: tender.id });
    const totals = (data as unknown as Array<Record<string, number | boolean>>)[0];
    expect(totals).toMatchObject({ lines: cases.length, priced: cases.length, subtotal_cents: ts.subtotalCents, vat_cents: ts.vatCents, total_cents: ts.totalCents, complete: true });
  });

  it("will not let the bidder change a quantity the tender prints, but lets them supply one the tender leaves out", async () => {
    const { f, tender } = await readyBid("bc-quantity");
    const printed = await tenderLine(f, tender.id, { quantity: 500, requirement: "doc-1" });
    const blank = await tenderLine(f, tender.id, { quantity: null, requirement: "doc-2" });
    const changed = await f.owner.client.rpc("save_pricing_line", { p_line_id: printed, p_unit_price_cents: 100, p_quantity: 400, p_supplier_ref: null as never, p_expected_version: 1 });
    expect(changed.error?.code).toBe("23514");
    expect(changed.error?.message).toMatch(/printed in the tender/i);
    expect((await f.owner.client.rpc("save_pricing_line", { p_line_id: printed, p_unit_price_cents: 100, p_quantity: 500, p_supplier_ref: null as never, p_expected_version: 1 })).error).toBeNull();
    expect((await f.owner.client.rpc("save_pricing_line", { p_line_id: blank, p_unit_price_cents: 100, p_quantity: 12.5, p_supplier_ref: null as never, p_expected_version: 1 })).error).toBeNull();
    expect((await linesOf(tender.id)).map((l) => [l.quantity, l.amount_cents])).toEqual([
      [500, 50_000],
      [12.5, 1250],
    ]);
  });

  it("refuses figures that make no sense", async () => {
    const { f, tender } = await readyBid("bc-bad");
    const id = (await f.owner.client.rpc("add_pricing_line", { p_tender_id: tender.id, p_description: "A line", p_unit: "each", p_quantity: 2 })).data!;
    const bad: Array<[string, Record<string, unknown>]> = [
      ["a negative price", { p_unit_price_cents: -1, p_quantity: 2 }],
      ["a price over R10bn", { p_unit_price_cents: 1_000_000_000_001, p_quantity: 2 }],
      ["a quantity of zero", { p_unit_price_cents: 100, p_quantity: 0 }],
      ["a quantity over a million", { p_unit_price_cents: 100, p_quantity: 1_000_001 }],
      ["a quantity with four decimals", { p_unit_price_cents: 100, p_quantity: 1.2345 }],
      ["an amount over the cap", { p_unit_price_cents: 1_000_000_000_000, p_quantity: 2 }],
    ];
    for (const [what, args] of bad) {
      const { error } = await f.owner.client.rpc("save_pricing_line", { p_line_id: id, p_supplier_ref: null as never, p_expected_version: 1, ...args } as never);
      expect(error?.code, what).toBe("23514");
    }
    const long = await f.owner.client.rpc("save_pricing_line", { p_line_id: id, p_unit_price_cents: 100, p_quantity: 2, p_supplier_ref: "x".repeat(121), p_expected_version: 1 });
    expect(long.error?.code).toBe("23514");
    expect((await linesOf(tender.id))[0]).toMatchObject({ unit_price_cents: null, version: 1 });
  });

  it("confirms the schedule only when every line has a quantity and a price, and a changed figure takes the confirmation away", async () => {
    const { f, tender } = await readyBid("bc-confirm");
    expect((await f.owner.client.rpc("set_pricing_confirmed", { p_tender_id: tender.id, p_confirmed: true })).error?.message).toMatch(/Every line needs a quantity and a price/);
    const id = (await f.owner.client.rpc("add_pricing_line", { p_tender_id: tender.id, p_description: "Supply and fix", p_unit: "sum", p_quantity: 1 })).data!;
    expect((await f.owner.client.rpc("set_pricing_confirmed", { p_tender_id: tender.id, p_confirmed: true })).error?.code).toBe("23514");
    await f.owner.client.rpc("save_pricing_line", { p_line_id: id, p_unit_price_cents: 0, p_quantity: 1, p_supplier_ref: null as never, p_expected_version: 1 });
    expect((await f.operator.client.rpc("set_pricing_confirmed", { p_tender_id: tender.id, p_confirmed: true })).error).toBeNull();
    const { rows } = await pool.query(`select confirmed_by, confirmed_at from public.bid_pricing where tender_id = $1`, [tender.id]);
    expect(rows[0].confirmed_by).toBe(f.operator.id);
    expect(rows[0].confirmed_at).not.toBeNull();
    expect((await auditActions(f.orgId, "bid.pricing_confirmed")).length).toBe(1);

    await f.owner.client.rpc("save_pricing_line", { p_line_id: id, p_unit_price_cents: 5000, p_quantity: 1, p_supplier_ref: null as never, p_expected_version: 2 });
    expect((await pool.query(`select confirmed_at from public.bid_pricing where tender_id = $1`, [tender.id])).rows[0].confirmed_at).toBeNull();
    expect((await history(tender.id, "PRICING")).map((h) => h.change)).toEqual(["CONFIRMED", "UNCONFIRMED"]);
  });

  it("lets a person add lines of their own and remove them, but not remove the tender's lines", async () => {
    const { f, tender } = await readyBid("bc-lines");
    const own = (await f.operator.client.rpc("add_pricing_line", { p_tender_id: tender.id, p_description: "Site establishment", p_unit: "sum", p_quantity: null as never })).data!;
    const fromTender = await tenderLine(f, tender.id);
    expect((await f.operator.client.rpc("remove_pricing_line", { p_line_id: fromTender })).error?.message).toMatch(/cannot be removed/);
    expect((await f.operator.client.rpc("remove_pricing_line", { p_line_id: own })).error).toBeNull();
    expect((await linesOf(tender.id)).map((l) => l.source)).toEqual(["TENDER"]);
    expect((await history(tender.id, "PRICING_LINE", own)).map((h) => h.change)).toEqual(["ADDED", "REMOVED"]);
    const tooShort = await f.operator.client.rpc("add_pricing_line", { p_tender_id: tender.id, p_description: "x", p_unit: "sum", p_quantity: 1 });
    expect(tooShort.error?.code).toBe("23514");
  });

  it("is for owners, admins and operators, refuses stale versions, and lets members read", async () => {
    const { f, tender } = await readyBid("bc-pricing-roles");
    const outsider = await createUser("bc-pricing-out");
    await bootstrapOrg(outsider);
    for (const user of [f.viewer, outsider]) {
      expect((await user.client.rpc("add_pricing_line", { p_tender_id: tender.id, p_description: "A line", p_unit: "each", p_quantity: 1 })).error?.code, user.email).toBe("42501");
    }
    const id = (await f.admin.client.rpc("add_pricing_line", { p_tender_id: tender.id, p_description: "A line", p_unit: "each", p_quantity: 1 })).data!;
    expect((await f.viewer.client.rpc("save_pricing_line", { p_line_id: id, p_unit_price_cents: 1, p_quantity: 1, p_supplier_ref: null as never, p_expected_version: 1 })).error?.code).toBe("42501");
    expect((await f.owner.client.rpc("save_pricing_line", { p_line_id: id, p_unit_price_cents: 1, p_quantity: 1, p_supplier_ref: null as never, p_expected_version: 1 })).error).toBeNull();
    expect((await f.admin.client.rpc("save_pricing_line", { p_line_id: id, p_unit_price_cents: 2, p_quantity: 1, p_supplier_ref: null as never, p_expected_version: 1 })).error?.message).toMatch(/changed by someone else/);
    expect((await f.viewer.client.from("bid_pricing_lines").select("id,amount_cents").eq("tender_id", tender.id)).data).toHaveLength(1);
    expect((await outsider.client.from("bid_pricing_lines").select("id").eq("tender_id", tender.id)).data).toEqual([]);
    expect((await outsider.client.from("bid_proposal_sections").select("id").eq("tender_id", tender.id)).data).toEqual([]);
    expect((await f.viewer.client.from("bid_pricing_lines").update({ unit_price_cents: 1 } as never).eq("id", id)).error).not.toBeNull();
    expect((await f.viewer.client.from("bid_proposal_sections").update({ content: "x" } as never).eq("tender_id", tender.id)).error).not.toBeNull();
  });

  it("never lets the AI's structure price anything: seeded lines arrive without figures, and a re-run keeps the person's", async () => {
    const { f, tender } = await readyBid("bc-reseed");
    const task = (await pool.query(`select id from public.tasks where tender_id = $1 limit 1`, [tender.id])).rows[0].id;
    const output = (lines: Array<{ requirement_id: string; description: string; quantity: number | null }>) => ({
      currency: "ZAR" as const,
      vat_rate: 0.15,
      lines: lines.map((l) => ({ ...l, unit: "m", unit_price_zar: null, source: "MISSING_INFORMATION" as const, supplier_quote_likely: true, quote: `${l.description} line`, page: 3 })),
      subtotal_zar: null,
      status: "REQUIRES_CONFIRMATION" as const,
      notes: ["Final pricing requires human approval"],
      requires_human_approval: true as const,
      simulated: false,
      ai_generated: true,
      vat: { rate: 0.15, treatment: "EXCLUSIVE" as const, status: "STATED" as const, requirement_id: "doc-9" },
    });
    const client = await pool.connect();
    try {
      await seedPricing(client, { organisationId: f.orgId, tenderId: tender.id, taskId: task, output: output([{ requirement_id: "doc-1", description: "Supply pipe", quantity: 500 }, { requirement_id: "doc-2", description: "Lay pipe", quantity: null }, { requirement_id: "doc-3", description: "Test pipe", quantity: 1 }]) });
      const seeded = await linesOf(tender.id);
      expect(seeded.map((l) => [l.requirement_id, l.quantity, l.quantity_printed, l.unit_price_cents, l.amount_cents])).toEqual([
        ["doc-1", 500, true, null, null],
        ["doc-2", null, false, null, null],
        ["doc-3", 1, true, null, null],
      ]);
      expect((await pool.query(`select vat_treatment, vat_status, vat_requirement_id, ai_generated from public.bid_pricing where tender_id = $1`, [tender.id])).rows[0]).toEqual({
        vat_treatment: "EXCLUSIVE",
        vat_status: "STATED",
        vat_requirement_id: "doc-9",
        ai_generated: true,
      });

      // A person prices the first line and supplies the quantity of the second.
      await f.operator.client.rpc("save_pricing_line", { p_line_id: seeded[0].id, p_unit_price_cents: 9900, p_quantity: 500, p_supplier_ref: "Q-1", p_expected_version: 1 });
      await f.operator.client.rpc("save_pricing_line", { p_line_id: seeded[1].id, p_unit_price_cents: null as never, p_quantity: 40, p_supplier_ref: null as never, p_expected_version: 1 });
      await pool.query(`update public.bid_pricing set confirmed_at = now(), confirmed_by = $2 where tender_id = $1`, [tender.id, f.operator.id]);

      // The re-run finds doc-1 and doc-2 again, and no longer finds doc-3.
      await seedPricing(client, { organisationId: f.orgId, tenderId: tender.id, taskId: task, output: output([{ requirement_id: "doc-1", description: "Supply pipe (revised)", quantity: 500 }, { requirement_id: "doc-2", description: "Lay pipe", quantity: null }]) });
    } finally {
      client.release();
    }
    const after = await linesOf(tender.id);
    expect(after.map((l) => [l.requirement_id, l.description, l.unit_price_cents, l.supplier_quote_ref, l.quantity])).toEqual([
      ["doc-1", "Supply pipe (revised)", 9900, "Q-1", 500],
      ["doc-2", "Lay pipe", null, null, 40],
    ]);
    // Something changed, so the confirmation no longer stands.
    expect((await pool.query(`select confirmed_at from public.bid_pricing where tender_id = $1`, [tender.id])).rows[0].confirmed_at).toBeNull();
  });
});

describe("a re-run never overwrites what a person did", () => {
  it("keeps a section a person edited, replaces one nobody touched, and keeps the figures entered", async () => {
    const { f, tender } = await readyBid("bc-rerun");
    await f.operator.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: "methodology", p_content: "Our own method.", p_expected_version: 1 });
    const id = (await f.operator.client.rpc("add_pricing_line", { p_tender_id: tender.id, p_description: "Mobilisation", p_unit: "sum", p_quantity: 1 })).data!;
    await f.operator.client.rpc("save_pricing_line", { p_line_id: id, p_unit_price_cents: 250000, p_quantity: 1, p_supplier_ref: null as never, p_expected_version: 1 });
    expect(await tenderStatus(tender.id)).toBe("PREPARING_BID");

    const rerun = await f.operator.client.rpc("rerun_bid", { p_tender_id: tender.id });
    expect(rerun.error).toBeNull();
    await drainOrg(worker(), pool, f.orgId);

    const sections = await sectionsOf(tender.id);
    expect(sections.find((s) => s.section_key === "methodology")).toMatchObject({ content: "Our own method.", edited_by: f.operator.id, version: 2 });
    expect(sections.find((s) => s.section_key === "quality")).toMatchObject({ content: null, version: 2 });
    expect(await linesOf(tender.id)).toHaveLength(1);
    expect((await linesOf(tender.id))[0]).toMatchObject({ unit_price_cents: 250000, amount_cents: 250000, source: "PERSON" });
  });
});

describe("QA reads what the person wrote", () => {
  it("passes the technical and pricing checks once every section is reviewed and the schedule is confirmed, and says what is still open before that", async () => {
    const { f, tender, runId } = await readyBid("bc-qa");
    expect((await qaOutput(runId)).verdict).toBe("CONDITIONAL");

    // Edit and review all six sections, enter and confirm a schedule. The first edit withdraws the approval.
    const keys = ["executive_summary", "methodology", "delivery_schedule", "staffing", "experience", "quality"];
    for (const key of keys) {
      const saved = await f.operator.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: key, p_content: `Our ${key} answer.`, p_expected_version: 1 });
      expect(saved.error, key).toBeNull();
    }
    expect(await tenderStatus(tender.id)).toBe("PREPARING_BID");
    // Part way: five reviewed, pricing not confirmed.
    for (const key of keys.slice(0, 5)) expect((await f.admin.client.rpc("set_proposal_section_review", { p_tender_id: tender.id, p_key: key, p_reviewed: true, p_expected_version: 2 })).error, key).toBeNull();
    const partial = (await f.operator.client.rpc("rerun_bid", { p_tender_id: tender.id })).data as string;
    await drainOrg(worker(), pool, f.orgId);
    const qaPartial = await qaOutput(partial);
    expect(qaPartial.checks.find((c) => c.key === "technical")).toMatchObject({ result: "OPEN_ISSUE", detail: "1 sections need information" });
    expect(qaPartial.checks.find((c) => c.key === "pricing")?.result).toBe("OPEN_ISSUE");
    expect(qaPartial.verdict).toBe("CONDITIONAL");

    // The rest: the last section reviewed, one line priced and the schedule confirmed. That waits for approval again, so edits withdraw it.
    expect((await f.admin.client.rpc("set_proposal_section_review", { p_tender_id: tender.id, p_key: keys[5], p_reviewed: true, p_expected_version: 2 })).error).toBeNull();
    const line = (await f.operator.client.rpc("add_pricing_line", { p_tender_id: tender.id, p_description: "Rehabilitate the access road", p_unit: "sum", p_quantity: 1 })).data!;
    expect((await f.operator.client.rpc("save_pricing_line", { p_line_id: line, p_unit_price_cents: 1_250_000_00, p_quantity: 1, p_supplier_ref: "Q-2026-14", p_expected_version: 1 })).error).toBeNull();
    expect((await f.operator.client.rpc("set_pricing_confirmed", { p_tender_id: tender.id, p_confirmed: true })).error).toBeNull();
    expect(await tenderStatus(tender.id)).toBe("PREPARING_BID");

    const again = (await f.operator.client.rpc("rerun_bid", { p_tender_id: tender.id })).data as string;
    await drainOrg(worker(), pool, f.orgId);
    const qa = await qaOutput(again);
    expect(qa.checks.find((c) => c.key === "technical")).toMatchObject({ result: "PASS" });
    expect(qa.checks.find((c) => c.key === "pricing")).toMatchObject({ result: "PASS" });
    expect(qa.checks.filter((c) => c.result !== "PASS")).toEqual([]);
    expect(qa.verdict).toBe("PASS");
    expect(await tenderStatus(tender.id)).toBe("READY_FOR_APPROVAL");
  });

  it("does not count a section the AI drafted until a person has reviewed it", async () => {
    const { f, tender } = await readyBid("bc-qa-ai");
    const client = await pool.connect();
    try {
      await seedProposal(client, {
        organisationId: f.orgId,
        tenderId: tender.id,
        taskId: (await pool.query(`select id from public.tasks where tender_id = $1 limit 1`, [tender.id])).rows[0].id,
        output: {
          ai_generated: true,
          simulated: false,
          open_items: 0,
          sections: ["executive_summary", "methodology", "delivery_schedule", "staffing", "experience", "quality"].map((key) => ({
            key,
            title: key,
            status: "DRAFTED" as const,
            content: `AI draft of ${key}.`,
            needs: [],
            paragraphs: [{ text: `AI draft of ${key}.`, fact_ids: ["fact:cidb_grade"], requirement_ids: [] }],
          })),
        },
      });
      const { proposal } = await loadBidContent(client, tender.id);
      // Whatever the AI called its own sections, none is complete until a person reviewed it.
      expect(proposal!.sections.every((s) => s.status === "REQUIRES_CONFIRMATION")).toBe(true);
      expect(proposal!.open_items).toBe(6);
    } finally {
      client.release();
    }
  });
});

describe("history and the audit trail", () => {
  it("keeps every version of a section, with who and when, and nobody can rewrite it", async () => {
    const { f, tender } = await readyBid("bc-history");
    await f.operator.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: "methodology", p_content: "One.", p_expected_version: 1 });
    await f.admin.client.rpc("save_proposal_section", { p_tender_id: tender.id, p_key: "methodology", p_content: "Two.", p_expected_version: 2 });
    const h = await history(tender.id, "PROPOSAL_SECTION", "methodology");
    expect(h.map((x) => [x.version, x.change, x.snapshot.content ?? null])).toEqual([
      [1, "SEEDED", null],
      [2, "EDITED", "One."],
      [3, "EDITED", "Two."],
    ]);
    expect(h.map((x) => x.changed_by)).toEqual([null, f.operator.id, f.admin.id]);
    const { data } = await f.viewer.client.from("bid_content_history").select("version").eq("tender_id", tender.id).eq("ref", "methodology");
    expect(data).toHaveLength(3);
    expect((await f.owner.client.from("bid_content_history").delete().eq("tender_id", tender.id)).error).not.toBeNull();
    expect((await f.owner.client.from("bid_content_history").update({ change: "NOPE" } as never).eq("tender_id", tender.id)).error).not.toBeNull();
  });
});
