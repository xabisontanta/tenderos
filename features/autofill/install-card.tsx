"use client";

import { RefreshCw, Puzzle } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Shown when the TenderOS browser helper is not found in this browser. */
export function InstallHelperCard({ onRecheck, checking }: { onRecheck: () => void; checking: boolean }) {
  return (
    <div className="grid gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4" role="region" aria-labelledby="install-helper-title">
      <div className="flex items-start gap-2">
        <Puzzle className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden />
        <div className="grid gap-1">
          <h3 id="install-helper-title" className="text-sm font-semibold">
            Install the TenderOS browser helper
          </h3>
          <p className="text-[13px] text-muted-foreground">
            The helper is a small extension for Chrome or Edge. It opens the portal, fills your company details and attaches your verified documents. You check
            everything and submit it yourself.
          </p>
        </div>
      </div>
      <ol className="grid list-decimal gap-1.5 pl-9 text-[13px]">
        <li>
          Get the helper folder: ask your TenderOS administrator for it, or run{" "}
          <code className="rounded bg-background/60 px-1 text-foreground">npm run build:extension</code> in the TenderOS project, which creates the folder{" "}
          <code className="rounded bg-background/60 px-1 text-foreground">extension/dist</code>.
        </li>
        <li>
          In Chrome open <code className="rounded bg-background/60 px-1 text-foreground">chrome://extensions</code> (in Edge{" "}
          <code className="rounded bg-background/60 px-1 text-foreground">edge://extensions</code>) and turn on{" "}
          <span className="font-medium">Developer mode</span>.
        </li>
        <li>
          Press <span className="font-medium">Load unpacked</span> and choose that folder. Pin the helper to the toolbar.
        </li>
        <li>
          Come back to this page and press <span className="font-medium">Check again</span>.
        </li>
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" variant="outline" onClick={onRecheck} disabled={checking}>
          <RefreshCw aria-hidden className={checking ? "animate-spin motion-reduce:animate-none" : undefined} /> {checking ? "Looking…" : "Check again"}
        </Button>
        <p className="text-[11px] text-muted-foreground">Once the helper is published in the Chrome Web Store, installing it will be a single click.</p>
      </div>
    </div>
  );
}
