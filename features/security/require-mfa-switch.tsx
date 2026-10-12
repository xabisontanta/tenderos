"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { setRequireMfa } from "./actions";

/**
 * "Require MFA for everyone". Owners switch it; everyone else just sees whether it is on. The explanation says what changes and
 * who gets locked out of what, because that is the risk: a member without an authenticator can still sign in and read, but
 * cannot approve, send, change settings or open documents until they set one up. The owner must have one first (the database
 * refuses to switch it on from a session that has not passed the challenge).
 */
export function RequireMfaSwitch({ on, isOwner, hasAuthenticator }: { on: boolean; isOwner: boolean; hasAuthenticator: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const helpId = useId();

  function apply(next: boolean) {
    setConfirming(false);
    setError(null);
    start(async () => {
      const r = await setRequireMfa(next);
      if (!r.ok) {
        setError(r.error);
        toast.error(r.error);
        return;
      }
      toast.success(next ? "Everyone now needs an authenticator" : "An authenticator is no longer required");
      router.refresh();
    });
  }

  return (
    <section aria-labelledby={`${helpId}-title`} className="grid gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${helpId}-title`} className="flex items-center gap-2 text-[13px] font-semibold">
          {on ? <ShieldCheck className="size-4 text-emerald-400" aria-hidden /> : <ShieldAlert className="size-4 text-muted-foreground" aria-hidden />}
          Require MFA for everyone
          <Badge variant={on ? "success" : "outline"}>{on ? "On" : "Off"}</Badge>
        </h3>
        {isOwner && (
          <Button
            type="button"
            aria-describedby={helpId}
            variant={on ? "outline" : "default"}
            size="sm"
            disabled={busy || (!on && !hasAuthenticator)}
            onClick={() => (on ? apply(false) : setConfirming(true))}
          >
            {busy ? "Saving…" : on ? "Switch off" : "Switch on"}
          </Button>
        )}
      </div>
      <div id={helpId} className="grid gap-1.5 text-[12px] text-muted-foreground">
        <p>
          {on
            ? "Everyone in your organisation must verify with an authenticator app, in their current session, before they can approve or send a bid, change settings or delivery details, manage the team, connect a mailbox, pair the browser helper, add, verify or remove documents, or open documents. Signing in and reading stay open."
            : "Ask everyone in your organisation to verify with an authenticator app, in their current session, before they can approve or send a bid, change settings or delivery details, manage the team, connect a mailbox, pair the browser helper, add, verify or remove documents, or open documents."}
        </p>
        {!on && (
          <p>
            <strong className="font-medium text-foreground">Lock-out risk.</strong> A member without an authenticator can still sign in and read, but cannot do
            any of that until they set one up here. Set up yours first (the switch needs it), and ask your admins and operators to set up theirs before you
            switch it on. Browser pairing codes made without an authenticator are revoked, and each person has to pair again.
          </p>
        )}
        {isOwner && !on && !hasAuthenticator && <p className="text-amber-300">Set up your own authenticator above first: the switch needs a verified one.</p>}
        {!isOwner && <p>Only an owner can change this.</p>}
        {on && isOwner && <p>Switching it off also needs a session that has passed the authenticator challenge.</p>}
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">
          {error}
        </p>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Require MFA for everyone?</AlertDialogTitle>
            <AlertDialogDescription>
              From now on every member needs an authenticator app, in their current session, to approve or send bids, change settings, manage the team, connect
              mailboxes, pair the browser helper or work with documents. Anyone without one can sign in and read but is stopped until they set one up. Everyone
              is notified, and browser pairing codes made without an authenticator are revoked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <Button onClick={() => apply(true)}>Switch on</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
