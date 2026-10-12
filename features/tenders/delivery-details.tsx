"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Lock, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { toDeliveryChanges, type DeliveryDetails as Details } from "@/lib/domain/delivery-lock";
import { humanize } from "@/lib/format";
import { changeTenderDelivery } from "./actions";

const METHODS = ["ELECTRONIC_PORTAL", "EMAIL", "PHYSICAL", "UNKNOWN"];

/** South African time (UTC+2, no daylight saving) for a datetime-local field. */
const toSastInput = (iso: string) => new Date(new Date(iso).getTime() + 2 * 3_600_000).toISOString().slice(0, 16);
const fromSastInput = (v: string) => `${v}:00+02:00`;

/**
 * Where and when the bid is delivered. While a bid is waiting for approval or delivery these details are locked;
 * owners and admins change them here, which withdraws the approval and sends the bid back for preparation.
 */
export function DeliveryDetails({ tenderId, details, locked, canChange }: { tenderId: string; details: Details; locked: boolean; canChange: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState(details.submission_destination ?? "");
  const [method, setMethod] = useState(details.submission_method);
  const [closing, setClosing] = useState(toSastInput(details.closing_at));
  const [url, setUrl] = useState(details.source_url ?? "");
  const [reason, setReason] = useState("");

  if (!locked && !canChange) return null;
  if (!canChange) {
    return (
      <p className="mt-4 flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Lock className="size-3.5" aria-hidden /> Delivery details are locked while this bid is waiting for approval or delivery, and cannot be changed once it
        was delivered. Until then an owner or admin can change them, which withdraws the approval.
      </p>
    );
  }

  const save = () =>
    start(async () => {
      const changes = toDeliveryChanges(details, {
        submission_destination: destination,
        submission_method: method,
        closing_at: closing ? fromSastInput(closing) : details.closing_at,
        source_url: url,
      });
      if (Object.keys(changes).length === 0) {
        toast.message("Nothing was changed");
        return;
      }
      const r = await changeTenderDelivery(tenderId, changes, reason);
      if (r.ok) {
        toast.success(r.data?.withdrawn ? "Delivery details changed; the approval was withdrawn" : "Delivery details changed");
        setOpen(false);
        setReason("");
        router.refresh();
      } else toast.error(r.error);
    });

  return (
    <div className="mt-4">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">
            <Pencil /> Change delivery details
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change delivery details</DialogTitle>
            <DialogDescription>
              {locked
                ? "This bid is waiting for approval or delivery. Changing where or when it is delivered withdraws the approval and sends the bid back for preparation; you prepare it again and it is approved afresh. The change is recorded with your reason."
                : "The change is recorded in the audit trail with your reason."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="dd-method">Submission method</Label>
              <NativeSelect id="dd-method" value={method} onChange={(e) => setMethod(e.target.value)} disabled={pending}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {humanize(m)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="dd-destination">Destination</Label>
              <Input id="dd-destination" value={destination} onChange={(e) => setDestination(e.target.value)} maxLength={500} disabled={pending} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="dd-closing">Closing date and time (South African time)</Label>
              <Input id="dd-closing" type="datetime-local" value={closing} onChange={(e) => setClosing(e.target.value)} disabled={pending} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="dd-url">Source link</Label>
              <Input id="dd-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2000} disabled={pending} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="dd-reason">Reason *</Label>
              <Textarea id="dd-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} disabled={pending} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Keep as is
            </Button>
            <Button onClick={save} disabled={pending || reason.trim().length < 3}>
              {locked ? "Withdraw approval and change" : "Change"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
