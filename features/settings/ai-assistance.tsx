"use client";

import { useId, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bot, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatUsd } from "@/lib/format";
import { setAiBudget, setAiSettings } from "./actions";
import { AI_BUDGET_MAX_USD } from "./ai-schema";

export interface AiAssistanceProps {
  enabled: boolean;
  webResearch: boolean;
  dailyBudgetUsd: number;
  canChange: boolean;
  /** Summed by the database; null when it could not be read. */
  spend: { today: number; month: number } | null;
  /** What this server's environment is missing before an AI step could start. */
  deployment: { allowed: boolean; problems: string[] };
}

/**
 * "AI assistance". Says in plain words what is sent to Anthropic and what never is, then lets an owner or admin switch it on
 * (only after ticking that they have read it), set the daily budget and see what has been spent. The database checks the role,
 * the authenticator requirement and the budget again.
 */
export function AiAssistance({ enabled, webResearch, dailyBudgetUsd, canChange, spend, deployment }: AiAssistanceProps) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [consent, setConsent] = useState(false);
  const [web, setWeb] = useState(webResearch);
  const [budget, setBudget] = useState(String(dailyBudgetUsd));
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  function applySettings(next: { enabled: boolean; webResearch: boolean }, done: string) {
    setError(null);
    start(async () => {
      const r = await setAiSettings({ ...next, consent: next.enabled && (enabled || consent) });
      if (!r.ok) {
        setError(r.error);
        toast.error(r.error);
        return;
      }
      toast.success(done);
      setConsent(false);
      router.refresh();
    });
  }

  function saveBudget() {
    setError(null);
    start(async () => {
      const r = await setAiBudget(budget);
      if (!r.ok) {
        setError(r.error);
        toast.error(r.error);
        return;
      }
      toast.success("Daily AI budget saved");
      router.refresh();
    });
  }

  const budgetChanged = Number(budget) !== dailyBudgetUsd;

  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-title`} className="flex items-center gap-2 text-[13px] font-semibold">
          <Bot className="size-4 text-muted-foreground" aria-hidden />
          Use AI to help prepare bids
          <Badge variant={enabled ? "success" : "outline"}>{enabled ? "On" : "Off"}</Badge>
        </h3>
        {canChange && enabled && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => applySettings({ enabled: false, webResearch: false }, "AI assistance is off")}
          >
            {busy ? "Saving…" : "Switch off"}
          </Button>
        )}
      </div>

      <div className="grid gap-3 text-[12px] text-muted-foreground sm:grid-cols-2">
        <div className="grid gap-1.5 rounded-lg border p-3">
          <h4 className="text-[12px] font-semibold text-foreground">What is sent to Anthropic</h4>
          <ul className="list-disc space-y-1 pl-4">
            <li>The tender&apos;s details and the text of the tender documents TenderOS has fetched.</li>
            <li>A short list of facts about your company: names, CIDB grade, B-BBEE level, provinces, sectors, and the titles of valid certificates.</li>
            <li>The draft proposal text written for the bid, so it can be checked.</li>
          </ul>
        </div>
        <div className="grid gap-1.5 rounded-lg border p-3">
          <h4 className="text-[12px] font-semibold text-foreground">What is never sent</h4>
          <ul className="list-disc space-y-1 pl-4">
            <li>Directors&apos; personal data, including ID documents.</li>
            <li>Bank details and bank confirmation letters.</li>
            <li>Proof of address.</li>
            <li>Prices: pricing figures are always typed in by a person, never produced by AI.</li>
          </ul>
        </div>
      </div>
      <p className="text-[12px] text-muted-foreground">
        Anthropic processes this outside South Africa. See the{" "}
        <Link href="/privacy" className="underline underline-offset-2">
          privacy notice
        </Link>{" "}
        for what that means. A person reads everything the AI drafts, and a person approves every submission. Nothing is sent while this is off.
      </p>

      {(!deployment.allowed || deployment.problems.length > 0) && (
        <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[12px]">
          <p className="font-medium">Not ready on this server{enabled ? ": AI steps will fail until this is fixed" : ""}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {deployment.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="mt-1 text-muted-foreground">This is checked on the web server. The worker that prepares bids needs the same settings.</p>
        </div>
      )}

      {canChange && !enabled && (
        <div className="grid gap-3 rounded-lg border p-3">
          <label className="flex items-start gap-2 text-[12px]" htmlFor={`${id}-consent`}>
            <input
              id={`${id}-consent`}
              type="checkbox"
              className="mt-0.5 accent-emerald-500"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>
              I have read what is sent to Anthropic and what is not, and I understand it is processed outside South Africa. I am allowed to switch this on for{" "}
              this organisation.
            </span>
          </label>
          <div>
            <Button
              type="button"
              size="sm"
              disabled={busy || !consent}
              onClick={() => applySettings({ enabled: true, webResearch: false }, "AI assistance is on")}
            >
              {busy ? "Saving…" : "Switch on AI assistance"}
            </Button>
          </div>
        </div>
      )}

      {canChange && enabled && (
        <div className="grid gap-1 rounded-lg border p-3">
          <label className="flex items-start gap-2 text-[12px]" htmlFor={`${id}-web`}>
            <input
              id={`${id}-web`}
              type="checkbox"
              className="mt-0.5 accent-emerald-500"
              checked={web}
              onChange={(e) => {
                setWeb(e.target.checked);
                applySettings({ enabled: true, webResearch: e.target.checked }, e.target.checked ? "Web research is on" : "Web research is off");
              }}
              disabled={busy}
              aria-describedby={`${id}-web-help`}
            />
            <span>Allow web research</span>
          </label>
          <p id={`${id}-web-help`} className="pl-6 text-[12px] text-muted-foreground">
            Lets the Tender Scout and the Intelligence Analyst search the public web through Anthropic. Search questions never include company or personal data.
            No step of the bid workflow uses it yet.
          </p>
        </div>
      )}

      {!canChange && <p className="text-[12px] text-muted-foreground">Only an owner or admin can change this.</p>}

      <div className="grid gap-2 border-t pt-3">
        <h4 className="flex items-center gap-2 text-[12px] font-semibold">
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
          Daily budget and spend
        </h4>
        <p className="text-[12px] text-muted-foreground">
          AI work stops, and the bid is held for a person, once a day&apos;s budget is spent. AI cannot be switched on without one.
        </p>
        <dl className="grid gap-1 text-[13px]">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Spent today</dt>
            <dd className="font-medium tabular-nums">{spend ? formatUsd(spend.today) : "Not available"}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Spent this month</dt>
            <dd className="font-medium tabular-nums">{spend ? formatUsd(spend.month) : "Not available"}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Daily budget</dt>
            <dd className="font-medium tabular-nums">{formatUsd(dailyBudgetUsd)}</dd>
          </div>
        </dl>
        {canChange && (
          <form
            noValidate
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              saveBudget();
            }}
          >
            <div className="grid gap-1">
              <Label htmlFor={`${id}-budget`}>Daily budget (US dollars)</Label>
              <Input
                id={`${id}-budget`}
                type="number"
                inputMode="decimal"
                min="0.01"
                max={AI_BUDGET_MAX_USD}
                step="0.01"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="w-40"
                aria-describedby={`${id}-budget-help`}
              />
            </div>
            <Button type="submit" size="sm" variant="outline" disabled={busy || !budgetChanged}>
              Save budget
            </Button>
            <p id={`${id}-budget-help`} className="basis-full text-[11px] text-muted-foreground">
              More than zero, up to ${AI_BUDGET_MAX_USD} a day.
            </p>
          </form>
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
