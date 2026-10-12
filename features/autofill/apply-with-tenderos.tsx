"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ExternalLink, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describePrepared, type PreparedSummary } from "@/lib/autofill/prepared";
import { InstallHelperCard } from "./install-card";
import { useBrowserHelper } from "./use-browser-helper";

/**
 * "Apply with TenderOS" on the tender page of an approved bid that is delivered
 * through a web portal. One click: the browser helper opens the portal in a new
 * tab, fills the company details, attaches the approved documents and shows a
 * review panel. The person checks everything and submits it themselves.
 */
export function ApplyWithTenderOS({
  tenderId,
  portalHost,
  sensitiveAvailable,
  prepared,
}: {
  tenderId: string;
  /** The portal host TenderOS will open, or null when the tender names no usable web address. */
  portalHost: string | null;
  /** Owners and admins only: the bid pack includes director IDs, a bank letter or proof of address. */
  sensitiveAvailable: boolean;
  prepared: PreparedSummary | null;
}) {
  const router = useRouter();
  const helper = useBrowserHelper();
  const { state } = helper;
  const [sensitive, setSensitive] = useState(false);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<{ state: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const phase = state.phase;
  const { getBridge } = helper;
  useEffect(() => {
    if (phase !== "ready") return;
    const bridge = getBridge();
    if (!bridge) return;
    return bridge.onApplyStatus((s) => {
      if (s.tenderId !== tenderId) return;
      setProgress({ state: s.state, message: s.message });
      if (s.state === "prepared") router.refresh();
    });
  }, [phase, getBridge, tenderId, router]);

  async function apply() {
    const bridge = helper.getBridge();
    if (!bridge) return;
    setError(null);
    setWorking(true);
    setProgress({ state: "opening", message: "Asking the browser helper to open the portal…" });
    try {
      const result = await bridge.apply(tenderId, sensitive);
      if (result === "needs_toolbar_click") {
        setProgress({
          state: "needs_toolbar_click",
          message: "The portal is open in a new tab. Click the TenderOS icon in your browser toolbar there, then press Fill this page.",
        });
      }
    } catch (err) {
      setProgress(null);
      setError(err instanceof Error ? err.message : "The browser helper could not start.");
    } finally {
      setWorking(false);
    }
  }

  async function connect() {
    if (await helper.connect("")) {
      toast.success("Browser connected");
      router.refresh();
    }
  }

  return (
    <section aria-labelledby="apply-title" className="grid gap-3 rounded-xl border border-violet-500/40 bg-violet-500/5 p-4">
      <div>
        <h2 id="apply-title" className="text-sm font-semibold">
          Apply with TenderOS
        </h2>
        <p className="text-xs text-muted-foreground">
          {portalHost ? (
            <>
              Opens <span className="font-medium text-foreground">{portalHost}</span> in a new tab, fills your company details and attaches the approved
              documents.{" "}
            </>
          ) : (
            "TenderOS has no usable web address for this tender's portal. Open the portal yourself, then click the TenderOS icon in your toolbar and press Fill this page. "
          )}
          You check everything and submit it yourself: TenderOS never presses Submit, ticks declarations, enters prices or signs.
        </p>
      </div>

      {prepared && (
        <p role="status" className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[13px]">
          {describePrepared(prepared)}
        </p>
      )}

      {phase === "detecting" && (
        <p role="status" className="text-[13px] text-muted-foreground">
          Looking for the TenderOS browser helper in this browser…
        </p>
      )}

      {phase === "missing" && <InstallHelperCard onRecheck={helper.recheck} checking={false} />}

      {(phase === "ready" || phase === "connecting" || phase === "disconnecting") && !state.pairing.paired && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={connect} disabled={phase !== "ready"}>
            <Plug aria-hidden /> {phase === "connecting" ? "Connecting…" : "Connect this browser first"}
          </Button>
          <p className="text-xs text-muted-foreground">One click, nothing to copy. You can disconnect any time in Settings.</p>
        </div>
      )}

      {(phase === "ready" || phase === "connecting" || phase === "disconnecting") && state.pairing.paired && portalHost && (
        <div className="grid gap-2">
          {sensitiveAvailable && (
            <label className="flex items-start gap-2 text-[13px]">
              <input
                type="checkbox"
                className="mt-0.5 accent-violet-500"
                checked={sensitive}
                onChange={(e) => setSensitive(e.target.checked)}
                disabled={working}
              />
              <span>Also attach the director ID copies, bank letter and proof of address from the bid pack</span>
            </label>
          )}
          <div>
            <Button type="button" onClick={apply} disabled={working || phase !== "ready"}>
              <ExternalLink aria-hidden /> {working ? "Opening the portal…" : "Apply with TenderOS"}
            </Button>
          </div>
        </div>
      )}

      {progress && (
        <p role="status" aria-live="polite" className="text-[13px]">
          {progress.message}
        </p>
      )}
      {(error || state.error) && (
        <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error ?? state.error}
        </p>
      )}
    </section>
  );
}
