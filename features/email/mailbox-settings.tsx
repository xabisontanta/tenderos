"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Mail } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { connectSmtp, disconnectEmail } from "./actions";

export interface MailboxRow {
  id: string;
  user_id: string;
  provider: "GMAIL" | "SMTP";
  from_address: string;
  smtp_host: string | null;
  status: string;
  last_error: string | null;
}

export function MailboxSettings({
  mailboxes,
  currentUserId,
  isAdmin,
  canConnect,
  gmailAvailable,
}: {
  mailboxes: MailboxRow[];
  currentUserId: string;
  isAdmin: boolean;
  canConnect: boolean;
  gmailAvailable: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ fromAddress: "", displayName: "", host: "", port: "587", username: "", password: "" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="grid gap-4">
      {mailboxes.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No mailbox connected. Bids that go by email need one.</p>
      ) : (
        <ul className="grid gap-1.5 text-[13px]">
          {mailboxes.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-1.5 first:border-t-0 first:pt-0">
              <span className="min-w-0">
                <span className="font-medium">{m.from_address}</span>
                <span className="text-muted-foreground"> · {m.provider === "GMAIL" ? "Gmail" : m.smtp_host}</span>
                {m.user_id === currentUserId && <span className="text-muted-foreground"> (yours)</span>}
                {m.last_error && <span className="block text-[11px] text-red-300">{m.last_error}</span>}
              </span>
              <span className="flex items-center gap-2">
                <Badge variant={m.status === "ACTIVE" ? "success" : "danger"}>{m.status === "ACTIVE" ? "Connected" : "Error"}</Badge>
                {(m.user_id === currentUserId || isAdmin) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const r = await disconnectEmail(m.id);
                        if (r.ok) {
                          toast.success("Mailbox disconnected and its password deleted");
                          router.refresh();
                        } else toast.error(r.error);
                      })
                    }
                  >
                    Disconnect
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canConnect && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {gmailAvailable ? (
              <Button asChild variant="outline">
                <a href="/api/email/google/start">
                  <Mail aria-hidden /> Connect Gmail
                </a>
              </Button>
            ) : (
              <p className="text-[12px] text-muted-foreground">Gmail sign-in is not set up on this server yet. Use your mail server settings below.</p>
            )}
            {gmailAvailable && <span className="text-[11px] text-muted-foreground">TenderOS asks for permission to send only; it cannot read your mail.</span>}
          </div>

          <form
            className="grid gap-3 rounded-lg border p-3"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              start(async () => {
                const r = await connectSmtp({ ...form, port: Number(form.port) });
                if (r.ok) {
                  toast.success("Mailbox connected. TenderOS signed in to it successfully.");
                  setForm((f) => ({ ...f, password: "" }));
                  router.refresh();
                } else setError(r.error);
              });
            }}
          >
            <p className="text-[13px] font-medium">Company email on your own domain (SMTP)</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="fromAddress" label="Send from">
                <Input
                  id="fromAddress"
                  type="email"
                  value={form.fromAddress}
                  onChange={set("fromAddress")}
                  placeholder="tenders@yourcompany.co.za"
                  disabled={pending}
                />
              </Field>
              <Field id="displayName" label="Sender name">
                <Input id="displayName" value={form.displayName} onChange={set("displayName")} placeholder="Your Company (Pty) Ltd" disabled={pending} />
              </Field>
              <Field id="host" label="Mail server">
                <Input id="host" value={form.host} onChange={set("host")} placeholder="mail.yourcompany.co.za" disabled={pending} />
              </Field>
              <Field id="port" label="Port">
                <NativeSelect id="port" value={form.port} onChange={set("port")} disabled={pending}>
                  <option value="587">587 (STARTTLS)</option>
                  <option value="465">465 (SSL)</option>
                  <option value="2525">2525</option>
                </NativeSelect>
              </Field>
              <Field id="username" label="Username">
                <Input id="username" value={form.username} onChange={set("username")} autoComplete="off" disabled={pending} />
              </Field>
              <Field id="password" label="Password">
                <Input id="password" type="password" value={form.password} onChange={set("password")} autoComplete="new-password" disabled={pending} />
              </Field>
            </div>
            <p className="text-[11px] text-muted-foreground">
              TenderOS signs in once to check the settings, then stores the password encrypted. Nobody in your organisation can view it, and disconnecting
              deletes it.
            </p>
            {error && (
              <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {error}
              </p>
            )}
            <div>
              <Button type="submit" disabled={pending}>
                {pending ? "Checking…" : "Test and connect"}
              </Button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
