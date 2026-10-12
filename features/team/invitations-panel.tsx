"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Mail, RotateCw, Send, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { formatDateTime } from "@/lib/format";
import { ROLE_DESCRIPTIONS, invitableRoles, type OrgRole } from "@/lib/team/roles";
import { inviteMember, resendInvitation, revokeInvitation, type IssuedInvitation } from "./invitations";

export interface InvitationRow {
  id: string;
  email: string;
  role: OrgRole;
  created_at: string;
  expires_at: string;
}

/**
 * Invite people by email with a role, see who has not answered yet, resend (a new link; the old one stops
 * working) or withdraw. Auditors and accountants who work inside your account are invited as viewers. The link
 * of a new or resent invitation is shown once, in case the email does not arrive; it works only for the address
 * it was sent to, so showing it to the inviter gives them nothing.
 */
export function InvitationsPanel({ invitations, actorRole }: { invitations: InvitationRow[]; actorRole: OrgRole }) {
  const router = useRouter();
  const roles = invitableRoles(actorRole);
  const [busy, start] = useTransition();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>(roles.includes("viewer") ? "viewer" : (roles[0] ?? "viewer"));
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedInvitation | null>(null);
  const [copied, setCopied] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const ids = { email: useId(), role: useId(), hint: useId(), error: useId(), roleHelp: useId() };

  function show(result: Awaited<ReturnType<typeof inviteMember>>, success: string) {
    if (!result.ok) {
      setError(result.error);
      toast.error(result.error);
      return false;
    }
    setError(null);
    setCopied(false);
    setIssued(result.data ?? null);
    toast.success(success);
    router.refresh();
    return true;
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIssued(null);
    start(async () => {
      const ok = show(await inviteMember(email, role), "Invitation created");
      if (ok) setEmail("");
      else emailRef.current?.focus();
    });
  }

  function resend(row: InvitationRow) {
    setError(null);
    setIssued(null);
    start(async () => void show(await resendInvitation(row.id), "Invitation resent with a new link"));
  }

  function revoke(row: InvitationRow) {
    setError(null);
    start(async () => {
      const r = await revokeInvitation(row.id);
      if (!r.ok) {
        setError(r.error);
        toast.error(r.error);
        return;
      }
      setIssued((cur) => (cur?.id === row.id ? null : cur));
      toast.success("Invitation withdrawn");
      router.refresh();
    });
  }

  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.link);
      setCopied(true);
    } catch {
      linkRef.current?.select();
      toast.error("Could not copy automatically. The link is selected: copy it with Ctrl+C.");
    }
  }

  if (roles.length === 0) return null;

  return (
    <div className="grid gap-4">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_11rem_auto] sm:items-end" noValidate>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.email}>Invite by email</Label>
          <Input
            id={ids.email}
            ref={emailRef}
            type="email"
            autoComplete="off"
            placeholder="name@company.co.za"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={[ids.hint, error ? ids.error : null].filter(Boolean).join(" ")}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.role}>Role</Label>
          <NativeSelect id={ids.role} value={role} onChange={(e) => setRole(e.target.value as OrgRole)} aria-describedby={ids.roleHelp}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {r === "viewer" ? "Viewer (read-only)" : ROLE_DESCRIPTIONS[r].label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" disabled={busy || email.trim() === ""}>
          <Send /> {busy ? "Sending…" : "Send invitation"}
        </Button>
        <p id={ids.roleHelp} className="text-[12px] text-muted-foreground sm:col-span-3">
          {ROLE_DESCRIPTIONS[role].summary}
        </p>
        <p id={ids.hint} className="text-[11px] text-muted-foreground sm:col-span-3">
          The invitation works for that address only, for 7 days.{" "}
          {actorRole === "admin" ? "Admins invite operators and viewers; an owner invites admins. " : ""}
          Owners are made from existing members, in the list above.
        </p>
      </form>

      {error && (
        <p id={ids.error} role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">
          {error}
        </p>
      )}

      {issued && (
        <section aria-label="New invitation" className="grid gap-2 rounded-lg border bg-muted/20 p-3 text-[13px]">
          <p role="status">
            {issued.emailed ? (
              <>
                <Mail className="mr-1 inline size-4 align-text-bottom text-emerald-400" aria-hidden />
                Invitation emailed
                {issued.email ? (
                  <>
                    {" "}
                    to <strong>{issued.email}</strong>
                  </>
                ) : null}
                .
              </>
            ) : (
              (issued.notice ?? "The invitation was created.")
            )}
          </p>
          <Label htmlFor={`${ids.email}-link`} className="text-[12px] text-muted-foreground">
            Invitation link{issued.emailed ? " (also in the email)" : ""}. Shown once; it works only for the invited address.
          </Label>
          <div className="flex gap-2">
            <Input id={`${ids.email}-link`} ref={linkRef} readOnly value={issued.link} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="outline" onClick={copy}>
              <Copy /> {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </section>
      )}

      <div>
        <h3 className="mb-1.5 text-[12px] font-semibold">Waiting for an answer</h3>
        {invitations.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No pending invitations.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-[13px]">
              <caption className="sr-only">Pending invitations, their roles and when they expire</caption>
              <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    Invited
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    Role
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    Expires
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((i) => {
                  const expired = Date.parse(i.expires_at) <= Date.now();
                  const canAct = !(i.role === "admin" && actorRole !== "owner");
                  return (
                    <tr key={i.id} className="border-t align-middle">
                      <th scope="row" className="break-all py-2 pr-3 font-normal">
                        {i.email}
                      </th>
                      <td className="py-2 pr-3">
                        <Badge variant="outline">{ROLE_DESCRIPTIONS[i.role].label}</Badge>
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {formatDateTime(i.expires_at)} {expired && <Badge variant="warning">Expired</Badge>}
                      </td>
                      <td className="py-2 text-right">
                        {canAct && (
                          <span className="inline-flex gap-1">
                            <Button variant="ghost" size="sm" disabled={busy} onClick={() => resend(i)} aria-label={`Resend the invitation to ${i.email}`}>
                              <RotateCw /> Resend
                            </Button>
                            <Button variant="ghost" size="sm" disabled={busy} onClick={() => revoke(i)} aria-label={`Withdraw the invitation to ${i.email}`}>
                              <X /> Withdraw
                            </Button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
