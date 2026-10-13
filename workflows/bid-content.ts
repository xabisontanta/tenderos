import type { PoolClient } from "@/lib/db/pool";
import type { PricingOutput } from "@/agents/pricing/schema";
import type { ProposalOutput } from "@/agents/proposal/schema";
import {
  mayReplaceWithNewDraft,
  pricingFromRows,
  proposalFromSections,
  seedState,
  type BidPricingLineRow,
  type BidPricingRow,
  type BidSectionRow,
} from "@/lib/domain/bid-content";

/**
 * Bid content for the worker: seeds the editable tables from the Proposal Writer's and Pricing Analyst's output, and reads
 * the content back, as the person left it, in the shapes QA and the Submission Officer already understand (migration 072).
 * A re-run never overwrites a section a person edited or reviewed, nor a figure a person entered.
 */

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

interface SectionDbRow {
  id: string;
  section_key: string;
  title: string;
  position: number;
  version: number;
  content: string | null;
  status: BidSectionRow["status"];
  ai_generated: boolean;
  needs: unknown;
  warnings: unknown;
  edited_at: string | null;
  reviewed_at: string | null;
}

const history = (c: PoolClient, org: string, tender: string, kind: string, ref: string, version: number, change: string, snapshot: Record<string, unknown>) =>
  c.query(`select private.bid_history($1, $2, $3, $4, $5, $6, $7::jsonb)`, [org, tender, kind, ref, version, change, JSON.stringify(snapshot)]);

/** Lists the Proposal Writer's sections for a person to review. Sections a person has touched are left alone. */
export async function seedProposal(c: PoolClient, a: { organisationId: string; tenderId: string; taskId: string; output: ProposalOutput }): Promise<void> {
  const { rows } = await c.query<SectionDbRow>(`select * from public.bid_proposal_sections where tender_id = $1 for update`, [a.tenderId]);
  const existing = new Map(rows.map((r) => [r.section_key, r]));
  for (const [position, s] of a.output.sections.entries()) {
    const state = seedState({ content: s.content, aiWrote: a.output.ai_generated === true });
    const factIds = [...new Set((s.paragraphs ?? []).flatMap((p) => p.fact_ids))];
    const requirementIds = [...new Set((s.paragraphs ?? []).flatMap((p) => p.requirement_ids))];
    const values = [
      state.content,
      state.status,
      state.ai_generated,
      JSON.stringify(s.needs),
      JSON.stringify(factIds),
      JSON.stringify(requirementIds),
      JSON.stringify(s.warnings ?? []),
    ];
    const prev = existing.get(s.key);
    if (!prev) {
      const { rows: made } = await c.query<{ version: number }>(
        `insert into public.bid_proposal_sections
           (organisation_id, tender_id, section_key, title, position, content, status, ai_generated, needs, fact_ids, requirement_ids, warnings, source_task_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13) returning version`,
        [a.organisationId, a.tenderId, s.key, s.title, position, ...values, a.taskId],
      );
      await history(c, a.organisationId, a.tenderId, "PROPOSAL_SECTION", s.key, made[0].version, "SEEDED", {
        content: state.content,
        status: state.status,
        ai_generated: state.ai_generated,
      });
    } else if (mayReplaceWithNewDraft({ edited_by: prev.edited_at ? "a person" : null, reviewed_by: prev.reviewed_at ? "a person" : null })) {
      const { rows: updated } = await c.query<{ version: number }>(
        `update public.bid_proposal_sections
            set title = $3, position = $4, content = $5, status = $6, ai_generated = $7, needs = $8::jsonb, fact_ids = $9::jsonb,
                requirement_ids = $10::jsonb, warnings = $11::jsonb, source_task_id = $12, version = version + 1
          where id = $1 and tender_id = $2 returning version`,
        [prev.id, a.tenderId, s.title, position, ...values, a.taskId],
      );
      await history(c, a.organisationId, a.tenderId, "PROPOSAL_SECTION", s.key, updated[0].version, "RESEEDED", {
        content: state.content,
        status: state.status,
        ai_generated: state.ai_generated,
      });
    }
  }
}

interface LineDbRow {
  id: string;
  position: number;
  version: number;
  source: "TENDER" | "PERSON";
  description: string;
  item_ref: string | null;
  quantity: number | string | null;
  quantity_printed: boolean;
  unit: string | null;
  unit_price_cents: number | string | null;
  supplier_quote_ref: string | null;
  supplier_quote_likely: boolean;
  requirement_id: string | null;
  quote: string | null;
  page: number | null;
  warning: string | null;
}

const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

/** Lists the Pricing Analyst's schedule lines for a person to price. A figure a person entered is never replaced. */
export async function seedPricing(c: PoolClient, a: { organisationId: string; tenderId: string; taskId: string; output: PricingOutput }): Promise<void> {
  await c.query(
    `insert into public.bid_pricing (tender_id, organisation_id, vat_treatment, vat_status, vat_requirement_id, notes, ai_generated, source_task_id)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
     on conflict (tender_id) do update
       set vat_treatment = excluded.vat_treatment, vat_status = excluded.vat_status, vat_requirement_id = excluded.vat_requirement_id,
           notes = excluded.notes, ai_generated = excluded.ai_generated, source_task_id = excluded.source_task_id`,
    [
      a.tenderId,
      a.organisationId,
      a.output.vat?.treatment ?? "NOT_STATED",
      a.output.vat?.status ?? "REQUIRES_CONFIRMATION",
      a.output.vat?.requirement_id ?? null,
      JSON.stringify(a.output.notes),
      a.output.ai_generated === true,
      a.taskId,
    ],
  );
  const { rows } = await c.query<LineDbRow>(`select * from public.bid_pricing_lines where tender_id = $1 for update`, [a.tenderId]);
  const byRequirement = new Map(rows.filter((r) => r.requirement_id).map((r) => [r.requirement_id!, r]));
  const keep = new Set<string>();
  let changed = false;

  for (const [position, l] of a.output.lines.entries()) {
    const printed = l.quantity !== null && l.quantity !== undefined;
    const fields = [
      l.description.slice(0, 300),
      l.item_ref ?? null,
      l.unit ?? null,
      l.quote ?? null,
      l.page ?? null,
      l.supplier_quote_likely === true,
      l.warning ?? null,
    ];
    const prev = l.requirement_id ? byRequirement.get(l.requirement_id) : undefined;
    if (!prev) {
      const { rows: made } = await c.query<{ id: string; version: number }>(
        `insert into public.bid_pricing_lines
           (organisation_id, tender_id, position, source, description, item_ref, unit, quote, page, supplier_quote_likely, warning,
            quantity, quantity_printed, requirement_id, source_task_id)
         values ($1,$2,$3,'TENDER',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id, version`,
        [a.organisationId, a.tenderId, position, ...fields, printed ? l.quantity : null, printed, l.requirement_id ?? null, a.taskId],
      );
      keep.add(made[0].id);
      changed = true;
      await history(c, a.organisationId, a.tenderId, "PRICING_LINE", made[0].id, made[0].version, "SEEDED", {
        description: fields[0],
        quantity: printed ? l.quantity : null,
      });
      continue;
    }
    keep.add(prev.id);
    // The tender's printed quantity follows the tender; a quantity a person entered where the tender printed none stays.
    const quantity = printed ? Number(l.quantity) : prev.quantity_printed ? null : num(prev.quantity);
    const quantityPrinted = printed;
    const same =
      prev.position === position &&
      prev.description === fields[0] &&
      prev.item_ref === fields[1] &&
      prev.unit === fields[2] &&
      prev.quote === fields[3] &&
      prev.page === fields[4] &&
      prev.supplier_quote_likely === fields[5] &&
      prev.warning === fields[6] &&
      num(prev.quantity) === quantity &&
      prev.quantity_printed === quantityPrinted;
    if (same) continue;
    const { rows: updated } = await c.query<{ version: number }>(
      `update public.bid_pricing_lines
          set position = $2, description = $3, item_ref = $4, unit = $5, quote = $6, page = $7, supplier_quote_likely = $8, warning = $9,
              quantity = $10, quantity_printed = $11, source_task_id = $12, version = version + 1
        where id = $1 returning version`,
      [prev.id, position, ...fields, quantity, quantityPrinted, a.taskId],
    );
    changed = true;
    await history(c, a.organisationId, a.tenderId, "PRICING_LINE", prev.id, updated[0].version, "RESEEDED", { description: fields[0], quantity });
  }

  // A tender line the analysis no longer finds goes, unless a person has already priced it.
  for (const r of rows) {
    if (r.source !== "TENDER" || keep.has(r.id) || r.unit_price_cents !== null || r.supplier_quote_ref !== null) continue;
    await c.query(`delete from public.bid_pricing_lines where id = $1`, [r.id]);
    changed = true;
    await history(c, a.organisationId, a.tenderId, "PRICING_LINE", r.id, r.version + 1, "DROPPED", { description: r.description });
  }
  if (changed) await c.query(`select private.unconfirm_pricing($1, $2)`, [a.organisationId, a.tenderId]);
}

/** The content as the person left it, in the shapes the agents read; null for a part that was never seeded. */
export async function loadBidContent(c: PoolClient, tenderId: string): Promise<{ proposal: ProposalOutput | null; pricing: PricingOutput | null }> {
  // One after the other: a single connection runs one query at a time.
  const { rows: sections } = await c.query<SectionDbRow>(`select * from public.bid_proposal_sections where tender_id = $1`, [tenderId]);
  const { rows: bids } = await c.query<{
    vat_treatment: BidPricingRow["vat_treatment"];
    vat_status: BidPricingRow["vat_status"];
    vat_requirement_id: string | null;
    notes: unknown;
    ai_generated: boolean;
    confirmed_at: string | null;
  }>(`select vat_treatment, vat_status, vat_requirement_id, notes, ai_generated, confirmed_at from public.bid_pricing where tender_id = $1`, [tenderId]);
  const { rows: lines } = await c.query<LineDbRow>(`select * from public.bid_pricing_lines where tender_id = $1`, [tenderId]);
  const proposal = sections.length
    ? proposalFromSections(
        sections.map((r): BidSectionRow => ({
          section_key: r.section_key,
          title: r.title,
          position: r.position,
          content: r.content,
          status: r.status,
          ai_generated: r.ai_generated,
          needs: strings(r.needs),
          warnings: strings(r.warnings),
        })),
      )
    : null;
  const bid = bids[0];
  const pricing =
    bid || lines.length
      ? pricingFromRows(
          bid
            ? {
                vat_treatment: bid.vat_treatment,
                vat_status: bid.vat_status,
                vat_requirement_id: bid.vat_requirement_id,
                notes: strings(bid.notes),
                ai_generated: bid.ai_generated,
                confirmed: bid.confirmed_at !== null,
              }
            : { vat_treatment: "NOT_STATED", vat_status: "REQUIRES_CONFIRMATION", vat_requirement_id: null, notes: [], ai_generated: false, confirmed: false },
          lines.map((r): BidPricingLineRow => ({
            id: r.id,
            position: r.position,
            source: r.source,
            description: r.description,
            item_ref: r.item_ref,
            quantity: r.quantity === null ? null : String(r.quantity),
            quantity_printed: r.quantity_printed,
            unit: r.unit,
            unit_price_cents: num(r.unit_price_cents),
            supplier_quote_ref: r.supplier_quote_ref,
            supplier_quote_likely: r.supplier_quote_likely,
            requirement_id: r.requirement_id,
            quote: r.quote,
            page: r.page,
            warning: r.warning,
          })),
        )
      : null;
  return { proposal, pricing };
}

/**
 * The step outputs an agent receives, with the proposal and pricing replaced by what the person reviewed and entered once
 * there is any. That is how QA's rules, its coverage evidence and the approval's package hash see the real bid.
 */
export async function overlayBidContent(c: PoolClient, tenderId: string, outputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { proposal, pricing } = await loadBidContent(c, tenderId);
  return { ...outputs, ...(proposal ? { proposal } : {}), ...(pricing ? { pricing } : {}) };
}
