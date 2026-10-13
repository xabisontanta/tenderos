"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { recordDelivery, sendBidEmail } from "./actions";

export interface DeliveryDocument {
  id: string;
  label: string;
  file_name: string;
  size_bytes: number | null;
}

export interface SentEmail {
  id: string;
  to_address: string;
  from_address: string;
  status: string;
  error: string | null;
  created_at: string;
}

function kb(n: number | null) {
  if (n === null) return "";
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Shown once a live bid is approved and waiting for a person to deliver it.
 * Email bids are sent from the member's own mailbox; other bids are recorded
 * after the person delivers them.
 */
export function BidDelivery({
  submissionId,
  method,
  destination,
  defaultSubject,
  defaultBody,
  mailboxes,
  documents,
  sent,
}: {
  submissionId: string;
  method: string;
  destination: string | null;
  defaultSubject: string;
  defaultBody: string;
  mailboxes: Array<{ id: string; from_address: string }>;
  documents: DeliveryDocument[];
  sent: SentEmail[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState(mailboxes[0]?.id ?? "");
  const [to, setTo] = useState(method === "EMAIL" ? (destination ?? "") : "");
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  const [picked, setPicked] = useState<string[]>(documents.map((d) => d.id));
  const [reference, setReference] = useState("");
  const total = documents.filter((d) => picked.includes(d.id)).reduce((n, d) => n + (d.size_bytes ?? 0), 0);
  // A message that is SENDING (in progress, or interrupted) or SENT blocks another send; the database enforces it too.
  const unfinished = sent.some((m) => m.status === "SENDING");
  const alreadySent = sent.some((m) => m.status === "SENT");

  const send = () => {
    setError(null);
    if (!confirm(`Send this bid to ${to} from ${mailboxes.find((m) => m.id === accountId)?.from_address}? This cannot be undone.`)) return;
    start(async () => {
      const r = await sendBidEmail({ submissionId, accountId, to, subject, body, documentIds: picked });
      if (r.ok) {
        toast.success("Bid emailed and recorded as delivered");
        router.refresh();
      } else setError(r.error);
    });
  };

  const record = () => {
    setError(null);
    start(async () => {
      const r = await recordDelivery({ submissionId, reference, note: method === "EMAIL" ? "Emailed outside TenderOS" : undefined });
      if (r.ok) {
        toast.success("Delivery recorded");
        router.refresh();
      } else setError(r.error);
    });
  };

  return (
    <div className="grid gap-4 rounded-xl border border-violet-500/40 bg-violet-500/5 p-4">
      <div>
        <p className="text-sm font-semibold">Deliver the approved bid</p>
        <p className="text-xs text-muted-foreground">Sign the declarations first. TenderOS sends or records the bid only when you press the button.</p>
      </div>

      {method === "EMAIL" && (
        <div className="grid gap-3">
          {mailboxes.length === 0 ? (
            <p className="text-[13px]">
              Connect your mailbox in{" "}
              <Link href="/settings#email" className="underline underline-offset-2">
                Settings
              </Link>{" "}
              to send this bid from your own address.
            </p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="from">From</Label>
                  <NativeSelect id="from" value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={pending}>
                    {mailboxes.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.from_address}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="to">To</Label>
                  <Input id="to" type="email" value={to} onChange={(e) => setTo(e.target.value)} disabled={pending} />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="subject">Subject</Label>
                <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} disabled={pending} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="body">Message</Label>
                <Textarea id="body" value={body} onChange={(e) => setBody(e.target.value)} rows={10} disabled={pending} />
              </div>
              <fieldset className="grid gap-1.5" disabled={pending}>
                <legend className="mb-1 text-sm font-medium">Attachments ({kb(total) || "none"})</legend>
                {documents.length === 0 && <p className="text-xs text-muted-foreground">No company documents were matched to this bid.</p>}
                {documents.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      className="accent-violet-500"
                      checked={picked.includes(d.id)}
                      onChange={() => setPicked((p) => (p.includes(d.id) ? p.filter((x) => x !== d.id) : [...p, d.id]))}
                    />
                    {d.label}{" "}
                    <span className="text-muted-foreground">
                      · {d.file_name} · {kb(d.size_bytes)}
                    </span>
                  </label>
                ))}
                <p className="text-[11px] text-muted-foreground">
                  Upload signed SBD forms and the priced schedule on the Documents page so they can be attached.
                </p>
              </fieldset>
              {(unfinished || alreadySent) && (
                <p role="status" className="text-[13px] text-amber-300">
                  {alreadySent
                    ? "This bid has been emailed. Record it as delivered below instead of sending it again."
                    : "An earlier attempt to email this bid did not finish. Check the mailbox's Sent folder: if the email went out, record it as delivered below and do not send it again."}
                </p>
              )}
              <div>
                <Button onClick={send} disabled={pending || !accountId || !to || unfinished || alreadySent}>
                  <Send aria-hidden /> {pending ? "Sending…" : "Send bid email"}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="grid gap-2 border-t pt-3">
        <p className="text-[13px]">
          {method === "EMAIL" ? "Sent it another way?" : "Delivered it in person or uploaded it on the portal?"} Record it so the tender closes.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="reference">Receipt or reference (optional)</Label>
            <Input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} disabled={pending} className="w-64" />
          </div>
          <Button variant="outline" onClick={record} disabled={pending}>
            Record as delivered
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {sent.length > 0 && (
        <ul className="grid gap-1 border-t pt-3 text-[12px]">
          {sent.map((m) => (
            <li key={m.id} className={m.status === "SENT" ? "text-muted-foreground" : m.status === "SENDING" ? "text-amber-300" : "text-red-300"}>
              {m.status === "SENT" ? "Sent" : m.status === "SENDING" ? "Sending, not confirmed" : "Failed"} to {m.to_address} from {m.from_address} ·{" "}
              {new Date(m.created_at).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })}
              {m.error && ` · ${m.error}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
