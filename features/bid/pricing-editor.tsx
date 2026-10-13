"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BidEditState } from "@/lib/domain/bid-content";
import { formatCents, SA_VAT_PERCENT } from "@/lib/domain/bid-money";
import { formatDateTime } from "@/lib/format";
import { addPricingLine, removePricingLine, savePricingLine, setPricingConfirmed } from "./actions";

export interface PriceLineView {
  id: string;
  version: number;
  source: "TENDER" | "PERSON";
  description: string;
  item_ref: string | null;
  quantity: number | null;
  quantity_printed: boolean;
  unit: string | null;
  unit_price_cents: number | null;
  supplier_quote_ref: string | null;
  supplier_quote_likely: boolean;
  quote: string | null;
  page: number | null;
  warning: string | null;
  amount_cents: number | null;
  vat_cents: number | null;
}

export interface PricingTotals {
  lines: number;
  priced: number;
  subtotal_cents: number;
  vat_cents: number;
  total_cents: number;
  complete: boolean;
}

const rands = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

/**
 * The pricing schedule for a person to price. TenderOS lists the lines the tender prints and a person types every figure: the
 * unit price (excluding VAT) and, where they have one, the supplier's quote reference. Amounts and VAT are worked out by the
 * database from those figures in whole cents, and shown here as it returns them; nothing on this screen is computed in the
 * browser. A person confirms the schedule when every line is priced; changing a figure afterwards takes the confirmation away.
 */
export function PricingEditor({
  tenderId,
  lines,
  totals,
  vat,
  confirmed,
  people,
  editState,
  canEdit,
}: {
  tenderId: string;
  lines: PriceLineView[];
  totals: PricingTotals;
  vat: { treatment: "EXCLUSIVE" | "INCLUSIVE" | "NOT_STATED"; stated: boolean; notes: string[] };
  confirmed: { by: string | null; at: string } | null;
  people: Record<string, string>;
  editState: BidEditState;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const editable = canEdit && editState !== "locked";

  function run(action: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    setError(null);
    start(async () => {
      const r = await action();
      if (!r.ok) {
        setError(r.error ?? "Something went wrong");
        toast.error(r.error ?? "Something went wrong");
        return;
      }
      toast.success(done);
      router.refresh();
    });
  }

  return (
    <section aria-label="Pricing" className="grid gap-3">
      <p role="note" className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-[12px]">
        <strong className="font-medium">Prices are entered by a person.</strong> TenderOS and its AI never produce a price, a rate or a total: every figure
        below was typed in by someone in your team, and the amounts are worked out from those figures. Enter unit prices excluding VAT; VAT at {SA_VAT_PERCENT}%
        is added for you.
      </p>
      <p className="text-[12px] text-muted-foreground">
        {vat.treatment === "NOT_STATED" || !vat.stated
          ? "The tender documents do not state whether prices are quoted including or excluding VAT. Check the tender before you submit."
          : vat.treatment === "INCLUSIVE"
            ? "The tender asks for prices including VAT: quote the total including VAT shown below."
            : "The tender asks for prices excluding VAT."}
      </p>
      {vat.notes.length > 0 && (
        <ul className="list-disc pl-5 text-[12px] text-muted-foreground">
          {vat.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {editState === "withdraws_approval" && canEdit && (
        <p role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[12px]">
          This bid is waiting for approval. Changing a figure withdraws the approval and sends the bid back for preparation. When you have finished, press
          <strong className="font-medium"> Prepare bid again</strong> at the top of the page.
        </p>
      )}
      {editState === "editable" && canEdit && (
        <p role="note" className="rounded-lg border p-3 text-[12px] text-muted-foreground">
          When you have finished, press <strong className="font-medium text-foreground">Prepare bid again</strong> at the top of the page to check the bid again
          with your figures.
        </p>
      )}
      {editState === "locked" && (
        <p role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[12px]">
          This bid has been approved or closed, so its prices can no longer be changed.
        </p>
      )}
      {!canEdit && editState !== "locked" && (
        <p className="text-[12px] text-muted-foreground">You can read the schedule. Only owners, admins and operators can enter prices.</p>
      )}

      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The analysis found no price schedule lines in the tender documents{canEdit ? ". Add the lines of your bid below." : "."}
        </p>
      ) : (
        <ul className="grid gap-3">
          {lines.map((l, i) => (
            <li key={`${l.id}:${l.version}`}>
              <LineCard index={i + 1} line={l} editable={editable} onRun={run} busy={busy} />
            </li>
          ))}
        </ul>
      )}

      <dl className="grid gap-1 rounded-lg border p-3 text-[13px]" aria-label="Bid totals">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Lines priced</dt>
          <dd className="font-medium tabular-nums">
            {totals.priced} of {totals.lines}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Subtotal excluding VAT</dt>
          <dd className="font-medium tabular-nums">{formatCents(totals.subtotal_cents)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">VAT at {SA_VAT_PERCENT}%</dt>
          <dd className="font-medium tabular-nums">{formatCents(totals.vat_cents)}</dd>
        </div>
        <div className="flex justify-between gap-3 border-t pt-1">
          <dt className="font-medium">Total including VAT</dt>
          <dd className="font-semibold tabular-nums">{formatCents(totals.total_cents)}</dd>
        </div>
        {!totals.complete && totals.lines > 0 && (
          <p className="pt-1 text-[11px] text-amber-300">The totals only include the lines that have a quantity and a price.</p>
        )}
      </dl>

      {editable && <AddLine tenderId={tenderId} onRun={run} busy={busy} />}

      <div className="flex flex-wrap items-center gap-2">
        {confirmed ? (
          <>
            <Badge variant="success">
              Confirmed by {confirmed.by ? (people[confirmed.by] ?? "a former team member") : "a team member"}, {formatDateTime(confirmed.at)}
            </Badge>
            {editable && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => run(() => setPricingConfirmed(tenderId, false), "Confirmation taken back")}
              >
                Take back confirmation
              </Button>
            )}
          </>
        ) : (
          <>
            <Badge variant="warning">Not confirmed</Badge>
            {editable && (
              <Button
                type="button"
                size="sm"
                disabled={busy || !totals.complete}
                onClick={() => run(() => setPricingConfirmed(tenderId, true), "Prices confirmed")}
              >
                Confirm prices
              </Button>
            )}
            {editable && !totals.complete && (
              <span className="text-[11px] text-muted-foreground">Every line needs a quantity and a price (R0.00 is allowed) before you can confirm.</span>
            )}
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">
          {error}
        </p>
      )}
    </section>
  );
}

function LineCard({
  index,
  line: l,
  editable,
  onRun,
  busy,
}: {
  index: number;
  line: PriceLineView;
  editable: boolean;
  onRun: (action: () => Promise<{ ok: boolean; error?: string }>, done: string) => void;
  busy: boolean;
}) {
  const id = useId();
  const [price, setPrice] = useState(rands(l.unit_price_cents));
  const [quantity, setQuantity] = useState(l.quantity === null ? "" : String(l.quantity));
  const [ref, setRef] = useState(l.supplier_quote_ref ?? "");
  const dirty =
    price.trim() !== rands(l.unit_price_cents) ||
    quantity.trim() !== (l.quantity === null ? "" : String(l.quantity)) ||
    ref.trim() !== (l.supplier_quote_ref ?? "");
  const name = `line ${index}${l.item_ref ? `, item ${l.item_ref}` : ""}`;

  return (
    <article aria-labelledby={`${id}-title`} className="grid gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-start gap-2">
        <h3 id={`${id}-title`} className="min-w-0 flex-1 text-[13px] font-medium">
          {l.item_ref && <span className="mr-1 text-muted-foreground">{l.item_ref}</span>}
          {l.description}
        </h3>
        {l.source === "PERSON" && <Badge variant="outline">Added by your team</Badge>}
        {l.supplier_quote_likely && !l.supplier_quote_ref && <Badge variant="warning">Usually needs a supplier quote</Badge>}
      </div>
      {l.quote && (
        <p className="text-[11px] text-muted-foreground">
          The tender prints: “{l.quote}”{l.page ? ` (page ${l.page})` : ""}
        </p>
      )}
      {l.warning && <p className="text-[11px] text-amber-300">{l.warning}</p>}
      <form
        className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (editable && dirty) onRun(() => savePricingLine(l.id, { unitPrice: price, quantity, supplierRef: ref, expectedVersion: l.version }), "Line saved");
        }}
      >
        <div className="grid gap-1">
          <Label htmlFor={`${id}-qty`}>Quantity{l.unit ? ` (${l.unit})` : ""}</Label>
          <Input
            id={`${id}-qty`}
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            readOnly={!editable || l.quantity_printed}
            aria-describedby={`${id}-qty-help`}
          />
          <p id={`${id}-qty-help`} className="text-[11px] text-muted-foreground">
            {l.quantity_printed ? "As printed in the tender" : "The tender prints no quantity: enter yours"}
          </p>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-price`}>Unit price excluding VAT (R)</Label>
          <Input id={`${id}-price`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} readOnly={!editable} placeholder="0.00" />
        </div>
        <div className="grid gap-1 sm:col-span-2 lg:col-span-2">
          <Label htmlFor={`${id}-ref`}>Supplier quote reference</Label>
          <Input id={`${id}-ref`} value={ref} onChange={(e) => setRef(e.target.value)} readOnly={!editable} maxLength={120} placeholder="Optional" />
        </div>
        <dl className="grid grid-cols-3 gap-2 text-[12px] sm:col-span-2 lg:col-span-4">
          <div>
            <dt className="text-muted-foreground">Amount</dt>
            <dd className="font-medium tabular-nums">{l.amount_cents === null ? "Not priced" : formatCents(l.amount_cents)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">VAT at {SA_VAT_PERCENT}%</dt>
            <dd className="font-medium tabular-nums">{l.vat_cents === null ? "" : formatCents(l.vat_cents)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Including VAT</dt>
            <dd className="font-medium tabular-nums">{l.amount_cents === null || l.vat_cents === null ? "" : formatCents(l.amount_cents + l.vat_cents)}</dd>
          </div>
        </dl>
        {editable && (
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit" size="sm" disabled={busy || !dirty} aria-label={`Save ${name}`}>
              Save line
            </Button>
            {l.source === "PERSON" && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                aria-label={`Remove ${name}`}
                onClick={() => onRun(() => removePricingLine(l.id), "Line removed")}
              >
                Remove
              </Button>
            )}
          </div>
        )}
      </form>
    </article>
  );
}

function AddLine({
  tenderId,
  onRun,
  busy,
}: {
  tenderId: string;
  onRun: (action: () => Promise<{ ok: boolean; error?: string }>, done: string) => void;
  busy: boolean;
}) {
  const id = useId();
  const [description, setDescription] = useState("");
  const [unit, setUnit] = useState("");
  const [quantity, setQuantity] = useState("");
  return (
    <form
      aria-label="Add a line"
      className="grid gap-2 rounded-lg border border-dashed p-3 sm:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        onRun(async () => {
          const r = await addPricingLine(tenderId, { description, unit, quantity });
          if (r.ok) {
            setDescription("");
            setUnit("");
            setQuantity("");
          }
          return r;
        }, "Line added");
      }}
    >
      <p className="text-[12px] font-medium sm:col-span-4">Add a line</p>
      <div className="grid gap-1 sm:col-span-2">
        <Label htmlFor={`${id}-description`}>Description</Label>
        <Input id={`${id}-description`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-unit`}>Unit</Label>
        <Input id={`${id}-unit`} value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={40} placeholder="m, each, sum" />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-quantity`}>Quantity</Label>
        <Input id={`${id}-quantity`} inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </div>
      <div className="sm:col-span-4">
        <Button type="submit" size="sm" variant="outline" disabled={busy || description.trim().length < 3}>
          Add line
        </Button>
      </div>
    </form>
  );
}
