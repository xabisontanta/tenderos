"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { LogOut, UserMinus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
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
import { ORG_ROLES, ROLE_DESCRIPTIONS, canRemoveMember, selectableRoles, type OrgRole } from "@/lib/team/roles";
import { changeMemberRole, removeMember } from "./actions";

export interface MemberRow {
  user_id: string;
  full_name: string | null;
  /** Only owners and admins are sent addresses; everyone else gets null. */
  email: string | null;
  role: OrgRole;
  joined_at: string;
}

type Pending = { kind: "owner"; member: MemberRow } | { kind: "self-demote"; member: MemberRow; role: OrgRole } | { kind: "remove"; member: MemberRow };

const nameOf = (m: MemberRow) => m.full_name?.trim() || "Unnamed member";

/**
 * The team: who is in the organisation and with which role. Owners and admins change roles and remove
 * people; the database refuses anything they may not do and says why. Everyone can see what each role means,
 * and leave. Making someone an owner, stepping down yourself and removing a person ask first.
 */
export function TeamMembers({ members, currentUserId, currentRole }: { members: MemberRow[]; currentUserId: string; currentRole: OrgRole }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const captionId = useId();

  function applyRole(m: MemberRow, role: OrgRole) {
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await changeMemberRole(m.user_id, role);
      if (r.ok) {
        const message = `${nameOf(m)} is now ${ROLE_DESCRIPTIONS[role].label}`;
        setNotice(message);
        toast.success(message);
        router.refresh();
      } else {
        setError(r.error);
        toast.error(r.error);
      }
    });
  }

  function applyRemove(m: MemberRow) {
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await removeMember(m.user_id);
      if (!r.ok) {
        setError(r.error);
        toast.error(r.error);
        return;
      }
      if (r.data?.left) {
        toast.success("You left the organisation");
        router.push("/");
      } else {
        const message = `${nameOf(m)} was removed`;
        setNotice(message);
        toast.success(message);
      }
      router.refresh();
    });
  }

  function onRoleChange(m: MemberRow, role: OrgRole) {
    if (role === m.role) return;
    if (role === "owner") return setPending({ kind: "owner", member: m });
    if (m.user_id === currentUserId && m.role === "owner") return setPending({ kind: "self-demote", member: m, role });
    applyRole(m, role);
  }

  function confirm() {
    const p = pending;
    setPending(null);
    if (!p) return;
    if (p.kind === "owner") applyRole(p.member, "owner");
    else if (p.kind === "self-demote") applyRole(p.member, p.role);
    else applyRemove(p.member);
  }

  return (
    <div className="grid gap-4">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-[13px]" aria-describedby={captionId}>
          <caption id={captionId} className="sr-only">
            Members of this organisation, their roles and when they joined
          </caption>
          <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="py-1.5 pr-3 font-medium">
                Member
              </th>
              <th scope="col" className="py-1.5 pr-3 font-medium">
                Role
              </th>
              <th scope="col" className="py-1.5 pr-3 font-medium">
                Joined
              </th>
              <th scope="col" className="py-1.5 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isSelf = m.user_id === currentUserId;
              const options = selectableRoles(currentRole, m.role);
              const removable = canRemoveMember(currentRole, m.role, isSelf);
              return (
                <tr key={m.user_id} className="border-t align-middle">
                  <th scope="row" className="py-2 pr-3 font-normal">
                    <span className="font-medium">{nameOf(m)}</span>
                    {isSelf && <span className="text-muted-foreground"> (you)</span>}
                    {m.email && <span className="block text-[12px] text-muted-foreground">{m.email}</span>}
                  </th>
                  <td className="py-2 pr-3">
                    {options.length > 0 ? (
                      <NativeSelect
                        aria-label={`Role of ${nameOf(m)}`}
                        className="h-8 w-32"
                        value={m.role}
                        disabled={busy}
                        onChange={(e) => onRoleChange(m, e.target.value as OrgRole)}
                      >
                        {options.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_DESCRIPTIONS[r].label}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : (
                      <Badge variant="outline">{ROLE_DESCRIPTIONS[m.role].label}</Badge>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-muted-foreground">{formatDate(m.joined_at)}</td>
                  <td className="py-2 text-right">
                    {removable && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={isSelf ? "Leave this organisation" : `Remove ${nameOf(m)}`}
                        onClick={() => setPending({ kind: "remove", member: m })}
                      >
                        {isSelf ? <LogOut /> : <UserMinus />} {isSelf ? "Leave" : "Remove"}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p role="status" className="min-h-4 text-[12px] text-emerald-400">
        {notice}
      </p>
      {error && (
        <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">
          {error}
        </p>
      )}

      <section aria-labelledby="role-help" className="rounded-lg border bg-muted/20 p-3">
        <h3 id="role-help" className="mb-2 text-[12px] font-semibold">
          What each role can do
        </h3>
        <dl className="grid gap-2 text-[12px]">
          {ORG_ROLES.map((r) => (
            <div key={r} className="grid gap-0.5 sm:grid-cols-[6rem_1fr] sm:gap-3">
              <dt className="font-medium">{ROLE_DESCRIPTIONS[r].label}</dt>
              <dd className="text-muted-foreground">{ROLE_DESCRIPTIONS[r].summary}</dd>
            </div>
          ))}
        </dl>
      </section>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending ? dialogTitle(pending, currentUserId) : ""}</AlertDialogTitle>
            <AlertDialogDescription>{pending ? dialogBody(pending, currentUserId) : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant={pending?.kind === "remove" ? "destructive" : "default"} onClick={confirm}>
              {pending?.kind === "remove" ? (pending.member.user_id === currentUserId ? "Leave" : "Remove") : "Confirm"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function dialogTitle(p: Pending, me: string): string {
  if (p.kind === "owner") return `Make ${nameOf(p.member)} an owner?`;
  if (p.kind === "self-demote") return `Step down to ${ROLE_DESCRIPTIONS[p.role].label}?`;
  return p.member.user_id === me ? "Leave this organisation?" : `Remove ${nameOf(p.member)}?`;
}

function dialogBody(p: Pending, me: string): string {
  if (p.kind === "owner")
    return "Owners can change everyone's role, remove members, and make others owners, including you. Use this to hand the organisation to someone, or to share it. You can step down afterwards.";
  if (p.kind === "self-demote") return "You will lose the owner's powers at once. Another owner can give them back.";
  if (p.member.user_id === me)
    return "You lose access to this organisation's tenders, bids and documents. Your browser pairing codes and connected mailboxes are removed. You can then create an organisation or accept an invitation to another.";
  return `${nameOf(p.member)} loses access to this organisation at once. Their browser pairing codes are revoked and their connected mailboxes are disconnected. Their past actions stay in the audit trail.`;
}
