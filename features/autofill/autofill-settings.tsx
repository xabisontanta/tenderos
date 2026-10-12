"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Copy, KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";
import { createAutofillToken, revokeAutofillToken } from "./actions";
import { ConnectBrowser } from "./connect-browser";

export interface AutofillTokenRow {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
}

export function AutofillSettings({ tokens }: { tokens: AutofillTokenRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now] = useState(() => Date.now());

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("Pairing code copied");
    } catch {
      toast.error("Could not copy. Select the code and copy it yourself.");
    }
  }

  return (
    <div className="grid gap-4">
      <ConnectBrowser rows={tokens} />
      <p className="text-[11px] text-muted-foreground">
        The helper fills company details and attaches your verified documents. It never presses submit, never ticks declarations, never enters prices and never
        signs. To use it, open an approved tender that is delivered through a portal and press{" "}
        <span className="font-medium text-foreground">Apply with TenderOS</span>.
      </p>

      <div className="grid gap-1.5">
        <h3 className="text-xs font-semibold text-muted-foreground">Browsers connected to your account</h3>
        {tokens.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">None yet.</p>
        ) : (
          <ul className="grid gap-1.5 text-[13px]">
            {tokens.map((t) => {
              const expired = new Date(t.expires_at).getTime() <= now;
              return (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-1.5 first:border-t-0 first:pt-0">
                  <span className="min-w-0">
                    <span className="font-medium">{t.label}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      Created {formatDateTime(t.created_at)} · last used {t.last_used_at ? formatDateTime(t.last_used_at) : "never"} ·{" "}
                      {expired ? "expired" : "expires"} {formatDateTime(t.expires_at)}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge variant={expired ? "secondary" : "success"}>{expired ? "Expired" : "Active"}</Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      aria-label={`Revoke ${t.label}`}
                      onClick={() =>
                        start(async () => {
                          const r = await revokeAutofillToken(t.id);
                          if (r.ok) {
                            toast.success("Pairing code revoked. The helper using it has stopped working.");
                            router.refresh();
                          } else toast.error(r.error);
                        })
                      }
                    >
                      Revoke
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-[13px] font-medium">Use a pairing code instead (advanced)</summary>
        <div className="mt-3 grid gap-3">
          <p className="text-[12px] text-muted-foreground">
            If the browser cannot connect on its own, create a code here and paste it into the helper&apos;s popup. The code is shown once.
          </p>
          {created && (
            <div className="grid gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3" role="status">
              <p className="text-[13px] font-medium">Your pairing code</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-md border bg-background/60 px-2 py-1.5 font-mono text-[12px] select-all">{created}</code>
                <Button type="button" size="sm" variant="outline" onClick={() => copy(created)}>
                  {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">Paste it into the helper now. It will not be shown again.</p>
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCreated(null);
                    setCopied(false);
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          )}
          <form
            className="flex flex-wrap items-end gap-2"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              start(async () => {
                const r = await createAutofillToken(label);
                if (r.ok && r.data) {
                  setCreated(r.data.token);
                  setCopied(false);
                  setLabel("");
                  router.refresh();
                } else if (!r.ok) setError(r.error);
              });
            }}
          >
            <div className="grid min-w-56 flex-1 gap-1.5">
              <Label htmlFor="autofill-label">Name this browser</Label>
              <Input
                id="autofill-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Office laptop, Chrome"
                maxLength={60}
                autoComplete="off"
                disabled={pending}
              />
            </div>
            <Button type="submit" variant="outline" disabled={pending}>
              <KeyRound aria-hidden /> {pending ? "Creating…" : "Create pairing code"}
            </Button>
          </form>
          {error && (
            <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
