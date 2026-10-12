"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Eye, EyeOff, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatDate } from "@/lib/format";
import { cancelEnrolment, confirmEnrolment, removeFactor, startEnrolment } from "./actions";

export interface FactorRow {
  id: string;
  name: string;
  verified: boolean;
  createdAt: string;
}

interface Setup {
  factorId: string;
  qrCode: string;
  secret: string;
}

/**
 * Settings, Security: set up, add and remove authenticator apps (TOTP). The QR code and the secret come from the Auth
 * server for this one setup and live only in this component's state: not stored, not logged, not in a URL. The first
 * code from the app switches the authenticator on. There are no recovery codes, so the screen says what to do instead.
 */
export function SecuritySettings({ factors }: { factors: FactorRow[] }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<FactorRow | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const codeId = useId();
  const secretId = useId();

  const active = factors.filter((f) => f.verified);

  function fail(message: string) {
    setError(message);
    toast.error(message);
  }

  function begin() {
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await startEnrolment(name);
      if (!r.ok || !r.data) return fail(r.ok ? "Could not start the setup" : r.error);
      setSetup(r.data);
      setCode("");
      setShowSecret(false);
      setTimeout(() => codeRef.current?.focus(), 0);
    });
  }

  function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!setup) return;
    setError(null);
    start(async () => {
      const r = await confirmEnrolment(setup.factorId, code);
      if (!r.ok) return fail(r.error);
      setSetup(null);
      setName("");
      setNotice("Your authenticator is on. From now on you will be asked for a code each time you sign in.");
      toast.success("Authenticator switched on");
      router.refresh();
    });
  }

  function cancel() {
    if (!setup) return;
    const factorId = setup.factorId;
    setSetup(null);
    setCode("");
    setError(null);
    start(async () => {
      await cancelEnrolment(factorId);
      router.refresh();
    });
  }

  function remove(f: FactorRow) {
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await removeFactor(f.id);
      if (!r.ok) return fail(r.error);
      setNotice(`${f.name} was removed.`);
      toast.success("Authenticator removed");
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
        <span className="font-medium">Authenticator app</span>
        {active.length > 0 ? <Badge variant="success">On</Badge> : <Badge variant="outline">Not set up</Badge>}
      </div>
      <p className="text-[13px] text-muted-foreground">
        A second step when you sign in: a six-digit code from an app such as Google Authenticator, Microsoft Authenticator, Authy or a password manager. A
        stolen password alone then opens nothing.
      </p>

      {active.length > 0 && (
        <ul className="grid gap-1.5 text-[13px]" aria-label="Your authenticators">
          {active.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-1.5 first:border-t-0 first:pt-0">
              <span>
                <KeyRound className="mr-1.5 inline size-4 align-text-bottom text-muted-foreground" aria-hidden />
                <span className="font-medium">{f.name}</span>
                <span className="text-muted-foreground"> · added {formatDate(f.createdAt)}</span>
              </span>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(f)} aria-label={`Remove ${f.name}`}>
                <Trash2 /> Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {!setup && (
        <div className="grid gap-2 sm:max-w-sm">
          <Label htmlFor={nameId}>{active.length > 0 ? "Add another authenticator" : "Set up an authenticator app"}</Label>
          <div className="flex gap-2">
            <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name it, e.g. My phone" maxLength={60} autoComplete="off" />
            <Button type="button" onClick={begin} disabled={busy}>
              {busy ? "Starting…" : "Start"}
            </Button>
          </div>
        </div>
      )}

      {setup && (
        <form onSubmit={confirm} className="grid gap-4 rounded-lg border bg-muted/20 p-4 sm:grid-cols-[auto_1fr]" aria-label="Set up an authenticator app">
          {/* The QR code is an SVG the Auth server made for this one setup, drawn in an image so nothing in it can run. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qrCode} alt="QR code to add TenderOS to your authenticator app" width={176} height={176} className="rounded-md bg-white p-2" />
          <div className="grid content-start gap-3 text-[13px]">
            <ol className="grid list-decimal gap-1 pl-5 text-muted-foreground">
              <li>Open your authenticator app and add an account by scanning the code.</li>
              <li>Enter the six-digit code it shows, to prove it works.</li>
            </ol>
            <div className="grid gap-1.5">
              <Label htmlFor={secretId}>Cannot scan? Enter this key in the app instead</Label>
              <div className="flex gap-2">
                <Input id={secretId} readOnly type={showSecret ? "text" : "password"} value={setup.secret} autoComplete="off" className="font-mono" />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowSecret((v) => !v)}
                  aria-label={showSecret ? "Hide the key" : "Show the key"}
                >
                  {showSecret ? <EyeOff /> : <Eye />}
                </Button>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={codeId}>Code from the app</Label>
              <Input
                id={codeId}
                ref={codeRef}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                required
                aria-invalid={error ? true : undefined}
                className="max-w-[10rem]"
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || code.replace(/\s/g, "").length < 6}>
                {busy ? "Checking…" : "Turn on"}
              </Button>
              <Button type="button" variant="ghost" onClick={cancel} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        </form>
      )}

      <p role="status" className="min-h-4 text-[12px] text-emerald-400">
        {notice}
      </p>
      {error && (
        <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">
          {error}
        </p>
      )}

      <section aria-labelledby="mfa-recovery" className="rounded-lg border bg-muted/20 p-3">
        <h3 id="mfa-recovery" className="mb-1.5 text-[12px] font-semibold">
          If you lose your phone
        </h3>
        <ul className="grid list-disc gap-1 pl-5 text-[12px] text-muted-foreground">
          <li>
            There are no backup codes. <strong className="font-medium text-foreground">Add a second authenticator now</strong> (another phone, a tablet, or a
            password manager that keeps one-time codes) so one lost device never locks you out.
          </li>
          <li>
            If you lose every authenticator, the owner of your organisation asks TenderOS support to reset yours. We confirm who you are first, sign you out
            everywhere and remove the authenticator; you sign in with your password and set up a new one.
          </li>
          <li>If you are the only owner, support asks for proof of identity before resetting it.</li>
        </ul>
      </section>

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {active.length <= 1
                ? "This is your only authenticator. Without it, signing in needs your password alone again, and any organisation that requires an authenticator will ask you to set one up before you can approve, send or change settings."
                : "You will no longer be able to use it to sign in. Your other authenticator stays on."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                const f = removing;
                setRemoving(null);
                if (f) remove(f);
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
