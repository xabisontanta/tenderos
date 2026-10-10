"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Radar, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { saveProvincesAndScan, scanNow } from "./actions";
import { DELIVERY_METHODS, WATCHABLE_PROVINCES } from "./provinces";

export function ProvinceScanner({
  watched,
  watchedMethods,
  autoRun,
  canChange,
  canScan,
  scanning,
}: {
  watched: string[];
  watchedMethods: string[];
  autoRun: boolean;
  canChange: boolean;
  canScan: boolean;
  scanning: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState<string[]>(watched);
  const [methods, setMethods] = useState<string[]>(watchedMethods);
  const [auto, setAuto] = useState(autoRun);
  const changed = (a: string[], b: string[]) => a.length !== b.length || a.some((x) => !b.includes(x));
  const dirty = auto !== autoRun || changed(selected, watched) || changed(methods, watchedMethods);

  const toggle = (v: string) => setSelected((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]));
  const toggleMethod = (v: string) => setMethods((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]));

  return (
    <div className="grid gap-4">
      <fieldset disabled={!canChange || pending} className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Provinces the agents should watch</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {WATCHABLE_PROVINCES.map((p) => {
            const on = selected.includes(p.value);
            return (
              <label
                key={p.value}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                  on ? "border-emerald-500/60 bg-emerald-500/10 text-foreground" : "text-muted-foreground hover:bg-accent",
                )}
              >
                <input type="checkbox" className="accent-emerald-500" checked={on} onChange={() => toggle(p.value)} />
                {p.label}
              </label>
            );
          })}
        </div>
      </fieldset>
      <fieldset disabled={!canChange || pending} className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">How you want to apply</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {DELIVERY_METHODS.map((m) => {
            const on = methods.includes(m.value);
            return (
              <label
                key={m.value}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                  on ? "border-emerald-500/60 bg-emerald-500/10 text-foreground" : "text-muted-foreground hover:bg-accent",
                )}
              >
                <input type="checkbox" className="mt-1 accent-emerald-500" checked={on} onChange={() => toggleMethod(m.value)} />
                <span>
                  {m.label}
                  <span className="block text-[11px] text-muted-foreground">{m.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        {methods.length === 0 && <p className="text-xs text-amber-400">Choose at least one way of applying.</p>}
      </fieldset>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1 accent-emerald-500"
          checked={auto}
          disabled={!canChange || pending}
          onChange={(e) => setAuto(e.target.checked)}
        />
        <span>
          Let the agents work every tender they find
          <span className="block text-xs text-muted-foreground">
            Each new tender goes straight to the Tender Director, who runs analysis, qualification, compliance, proposal, pricing and QA. You are only asked to
            approve the finished bid.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        {canChange && (
          <Button
            disabled={pending || scanning || selected.length === 0 || methods.length === 0}
            onClick={() =>
              start(async () => {
                const r = await saveProvincesAndScan(selected, methods, auto, true);
                if (r.ok) {
                  toast.success("Scan started. The Tender Scout is reading eTenders.");
                  router.refresh();
                } else toast.error(r.error);
              })
            }
          >
            <Radar /> {dirty ? "Save and scan now" : "Scan now"}
          </Button>
        )}
        {canChange && dirty && (
          <Button
            variant="outline"
            disabled={pending || methods.length === 0}
            onClick={() =>
              start(async () => {
                const r = await saveProvincesAndScan(selected, methods, auto, false);
                if (r.ok) {
                  toast.success("Saved. The agents will scan these provinces every morning.");
                  router.refresh();
                } else toast.error(r.error);
              })
            }
          >
            Save only
          </Button>
        )}
        {!canChange && canScan && (
          <Button
            disabled={pending || scanning || watched.length === 0}
            onClick={() =>
              start(async () => {
                const r = await scanNow();
                if (r.ok) {
                  toast.success("Scan started");
                  router.refresh();
                } else toast.error(r.error);
              })
            }
          >
            <RefreshCw /> Scan now
          </Button>
        )}
      </div>
      {!canChange && <p className="text-xs text-muted-foreground">Only owners and admins can change the watched provinces.</p>}
    </div>
  );
}
