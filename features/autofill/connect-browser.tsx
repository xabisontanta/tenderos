"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plug, Unplug } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";
import { matchPairing, type PairingRow } from "./connection";
import { InstallHelperCard } from "./install-card";
import { useBrowserHelper } from "./use-browser-helper";

/**
 * Settings, Browser helper: connect this browser with one click. TenderOS creates
 * the pairing code and hands it to the helper directly; nothing to copy or paste.
 */
export function ConnectBrowser({ rows }: { rows: PairingRow[] }) {
  const router = useRouter();
  const helper = useBrowserHelper();
  const { state } = helper;
  const [label, setLabel] = useState("");
  const [now] = useState(() => Date.now());
  const match = matchPairing(state.pairing, rows, now);
  const busy = state.phase === "connecting" || state.phase === "disconnecting";

  async function connect() {
    if (await helper.connect(label.trim())) {
      toast.success("Browser connected");
      setLabel("");
      router.refresh();
    }
  }

  async function disconnect() {
    // A pairing TenderOS cannot match (pasted by hand, already revoked) has no row to revoke; the helper just forgets it.
    if (await helper.disconnect(match.kind === "connected" || match.kind === "expired" ? match.row.id : null)) {
      toast.success("Browser disconnected. Its pairing code no longer works.");
      router.refresh();
    }
  }

  return (
    <div className="grid gap-3" aria-busy={state.phase === "detecting" || busy}>
      {state.phase === "detecting" && (
        <p role="status" className="text-[13px] text-muted-foreground">
          Looking for the TenderOS browser helper in this browser…
        </p>
      )}

      {state.phase === "missing" && <InstallHelperCard onRecheck={helper.recheck} checking={false} />}

      {(state.phase === "ready" || busy) && (
        <>
          {state.pairing.paired ? (
            <div className="grid gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3" role="status">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[13px] font-medium">
                  {match.kind === "connected" && <>This browser is connected: {match.row.label}</>}
                  {match.kind === "expired" && <>This browser&apos;s pairing code has expired: {match.row.label}</>}
                  {match.kind === "unknown" && <>This browser is connected with a pairing code TenderOS cannot match to your list</>}
                </p>
                <Badge variant={match.kind === "connected" ? "success" : "secondary"}>{match.kind === "connected" ? "Connected" : "Needs attention"}</Badge>
              </div>
              {(match.kind === "connected" || match.kind === "expired") && (
                <p className="text-[11px] text-muted-foreground">
                  Last used {match.row.last_used_at ? formatDateTime(match.row.last_used_at) : "never"} · {match.kind === "expired" ? "expired" : "expires"}{" "}
                  {formatDateTime(match.row.expires_at)}
                </p>
              )}
              {match.kind === "unknown" && (
                <p className="text-[11px] text-muted-foreground">
                  It may have been pasted in by hand, revoked or removed. Reconnect to replace it with a fresh one.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {match.kind !== "connected" && (
                  <Button type="button" size="sm" onClick={connect} disabled={busy}>
                    <Plug aria-hidden /> {state.phase === "connecting" ? "Connecting…" : "Reconnect"}
                  </Button>
                )}
                <Button type="button" size="sm" variant="outline" onClick={disconnect} disabled={busy}>
                  <Unplug aria-hidden /> {state.phase === "disconnecting" ? "Disconnecting…" : "Disconnect"}
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="flex flex-wrap items-end gap-2"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void connect();
              }}
            >
              <div className="grid min-w-56 flex-1 gap-1.5">
                <Label htmlFor="connect-label">Name this browser (optional)</Label>
                <Input
                  id="connect-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Office laptop, Chrome"
                  maxLength={60}
                  autoComplete="off"
                  disabled={busy}
                />
              </div>
              <Button type="submit" disabled={busy}>
                <Plug aria-hidden /> {state.phase === "connecting" ? "Connecting…" : "Connect browser"}
              </Button>
            </form>
          )}
          <p className="text-[11px] text-muted-foreground">
            TenderOS gives the helper its pairing code directly. You never see, copy or paste it. It works for 30 days, only for you, and you can disconnect it
            here at any time.
          </p>
        </>
      )}

      {state.error && (
        <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {state.error}
        </p>
      )}
    </div>
  );
}
