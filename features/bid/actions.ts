"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { getServerSupabase } from "@/lib/supabase/server";
import { canOperate, requireContext } from "@/lib/data/context";
import { toUserError, type ActionResult } from "@/lib/actions";
import { parseQuantity, parseRandsToCents } from "@/lib/domain/bid-money";

/**
 * What a person types into the proposal and pricing screens, checked here and again by the database. Money is turned into
 * whole cents on the server, so the database never receives a float; the database then computes every line and bid total.
 * Owners, admins and operators only, with the second factor when the organisation requires one (the database asks for it).
 */

const uuid = z.string().uuid();
const sectionKey = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/);
const version = z.number().int().min(1).max(1_000_000);
const NOT_ALLOWED = "You do not have permission to change the bid";

type Db = SupabaseClient<Database>;

async function operator(): Promise<boolean> {
  const ctx = await requireContext();
  return canOperate(ctx.role);
}

/** Runs one database function as the signed-in person and turns a refusal into a sentence they can act on. */
async function call<T>(run: (supabase: Db) => PromiseLike<{ data: T | null; error: PostgrestError | null }>, failure: string): Promise<ActionResult<T>> {
  const { data, error } = await run(await getServerSupabase());
  if (error) return { ok: false, error: toUserError(error, failure) };
  return { ok: true, data: data as T };
}

export async function saveProposalSection(tenderId: string, key: string, content: string, expectedVersion: number): Promise<ActionResult<{ version: number }>> {
  if (!uuid.safeParse(tenderId).success) return { ok: false, error: "Invalid tender" };
  if (!sectionKey.safeParse(key).success) return { ok: false, error: "Invalid section" };
  if (!version.safeParse(expectedVersion).success) return { ok: false, error: "Reload the page and try again" };
  if (typeof content !== "string" || content.length > 20000) return { ok: false, error: "A section can hold 20 000 characters at most" };
  if (!(await operator())) return { ok: false, error: NOT_ALLOWED };
  const res = await call<number>(
    (s) => s.rpc("save_proposal_section", { p_tender_id: tenderId, p_key: key, p_content: content, p_expected_version: expectedVersion }),
    "Could not save the section",
  );
  if (!res.ok) return res;
  revalidatePath(`/tenders/${tenderId}`);
  return { ok: true, data: { version: Number(res.data) } };
}

export async function setSectionReviewed(tenderId: string, key: string, reviewed: boolean, expectedVersion: number): Promise<ActionResult<{ version: number }>> {
  if (!uuid.safeParse(tenderId).success) return { ok: false, error: "Invalid tender" };
  if (!sectionKey.safeParse(key).success) return { ok: false, error: "Invalid section" };
  if (!version.safeParse(expectedVersion).success) return { ok: false, error: "Reload the page and try again" };
  if (!(await operator())) return { ok: false, error: NOT_ALLOWED };
  const res = await call<number>(
    (s) => s.rpc("set_proposal_section_review", { p_tender_id: tenderId, p_key: key, p_reviewed: reviewed === true, p_expected_version: expectedVersion }),
    "Could not change the review",
  );
  if (!res.ok) return res;
  revalidatePath(`/tenders/${tenderId}`);
  return { ok: true, data: { version: Number(res.data) } };
}

export interface PricingLineInput {
  /** Rands as typed, excluding VAT. Empty clears the price. */
  unitPrice: string;
  /** As typed. For a line whose quantity the tender prints, the printed quantity (it cannot be changed). */
  quantity: string | null;
  supplierRef: string;
  expectedVersion: number;
}

export async function savePricingLine(lineId: string, input: PricingLineInput): Promise<ActionResult<{ version: number }>> {
  if (!uuid.safeParse(lineId).success) return { ok: false, error: "Invalid line" };
  if (!version.safeParse(input.expectedVersion).success) return { ok: false, error: "Reload the page and try again" };
  let cents: number | null = null;
  if (input.unitPrice.trim() !== "") {
    const price = parseRandsToCents(input.unitPrice);
    if (!price.ok) return { ok: false, error: `Unit price: ${price.error}` };
    cents = price.cents;
  }
  let quantity: number | null = null;
  if (input.quantity !== null && input.quantity.trim() !== "") {
    const q = parseQuantity(input.quantity);
    if (!q.ok) return { ok: false, error: `Quantity: ${q.error}` };
    quantity = Number(q.value);
  }
  const ref = (input.supplierRef ?? "").trim();
  if (ref.length > 120) return { ok: false, error: "A supplier quote reference can be 120 characters at most" };
  if (!(await operator())) return { ok: false, error: NOT_ALLOWED };
  const res = await call<number>(
    (s) => s.rpc("save_pricing_line", { p_line_id: lineId, p_unit_price_cents: cents as number, p_quantity: quantity as number, p_supplier_ref: ref, p_expected_version: input.expectedVersion }),
    "Could not save the line",
  );
  if (!res.ok) return res;
  revalidatePath("/tenders/[id]", "page");
  return { ok: true, data: { version: Number(res.data) } };
}

export async function addPricingLine(tenderId: string, input: { description: string; unit: string; quantity: string }): Promise<ActionResult<{ id: string }>> {
  if (!uuid.safeParse(tenderId).success) return { ok: false, error: "Invalid tender" };
  const description = (input.description ?? "").trim();
  if (description.length < 3 || description.length > 300) return { ok: false, error: "Describe the line in 3 to 300 characters" };
  const unit = (input.unit ?? "").trim();
  if (unit.length > 40) return { ok: false, error: "A unit can be 40 characters at most" };
  let quantity: number | null = null;
  if ((input.quantity ?? "").trim() !== "") {
    const q = parseQuantity(input.quantity);
    if (!q.ok) return { ok: false, error: `Quantity: ${q.error}` };
    quantity = Number(q.value);
  }
  if (!(await operator())) return { ok: false, error: NOT_ALLOWED };
  const res = await call<string>((s) => s.rpc("add_pricing_line", { p_tender_id: tenderId, p_description: description, p_unit: unit, p_quantity: quantity as number }), "Could not add the line");
  if (!res.ok) return res;
  revalidatePath(`/tenders/${tenderId}`);
  return { ok: true, data: { id: String(res.data) } };
}

export async function removePricingLine(lineId: string): Promise<ActionResult> {
  if (!uuid.safeParse(lineId).success) return { ok: false, error: "Invalid line" };
  if (!(await operator())) return { ok: false, error: NOT_ALLOWED };
  const res = await call<undefined>((s) => s.rpc("remove_pricing_line", { p_line_id: lineId }), "Could not remove the line");
  if (!res.ok) return res;
  revalidatePath("/tenders/[id]", "page");
  return { ok: true };
}

export async function setPricingConfirmed(tenderId: string, confirmed: boolean): Promise<ActionResult> {
  if (!uuid.safeParse(tenderId).success) return { ok: false, error: "Invalid tender" };
  if (!(await operator())) return { ok: false, error: NOT_ALLOWED };
  const res = await call<undefined>((s) => s.rpc("set_pricing_confirmed", { p_tender_id: tenderId, p_confirmed: confirmed === true }), "Could not change the confirmation");
  if (!res.ok) return res;
  revalidatePath(`/tenders/${tenderId}`);
  return { ok: true };
}
