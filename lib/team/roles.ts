/**
 * Organisation roles in plain words, and which role changes the member menu offers. Used by the Team
 * settings and the invitation form. The database (`change_member_role`, `remove_member`,
 * `create_invitation`) is the enforcement point; these helpers only keep the screen from offering what the
 * database would refuse, and a test pins them to the same rules.
 */
export type OrgRole = "owner" | "admin" | "operator" | "viewer";

export const ORG_ROLES: readonly OrgRole[] = ["owner", "admin", "operator", "viewer"];

export const ROLE_DESCRIPTIONS: Record<OrgRole, { label: string; summary: string }> = {
  owner: {
    label: "Owner",
    summary:
      "Runs the organisation. Does everything an admin can, and also makes people owners or admins, requires multi-factor sign-in for everyone and downloads the organisation's data. There is always at least one owner.",
  },
  admin: {
    label: "Admin",
    summary:
      "Approves and sends bids, verifies documents, opens director IDs and bank letters, connects the company mailbox, and manages operators and viewers.",
  },
  operator: {
    label: "Operator",
    summary: "Adds tenders, uploads documents and starts bid preparation. Cannot approve or send a bid, and cannot open director IDs or bank letters.",
  },
  viewer: {
    label: "Viewer",
    summary:
      "Read-only: auditors and accountants. Sees tenders, bids and activity, and the documents that are not director IDs or bank letters. Changes nothing.",
  },
};

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value);
}

/**
 * The roles the menu offers `actor` for a member who is `target` now (the current role stays in the list when
 * it is one the actor could not hand out, so the menu still shows it). Empty means the actor cannot change
 * this member. Mirrors `change_member_role`: owners change anything; admins change admins, operators and
 * viewers, but cannot make anyone an owner or an admin; nobody else changes roles.
 */
export function selectableRoles(actor: OrgRole, target: OrgRole): OrgRole[] {
  if (actor === "owner") return [...ORG_ROLES];
  if (actor === "admin") {
    if (target === "owner") return [];
    return target === "admin" ? ["admin", "operator", "viewer"] : ["operator", "viewer"];
  }
  return [];
}

/** Mirrors `remove_member`: owners remove anyone, admins anyone but an owner, and every member can leave. */
export function canRemoveMember(actor: OrgRole, target: OrgRole, isSelf: boolean): boolean {
  if (isSelf) return true;
  if (actor === "owner") return true;
  return actor === "admin" && target !== "owner";
}

/** The roles an invitation can carry. Never owner: ownership is given to someone who is already a member. */
export function invitableRoles(actor: OrgRole): OrgRole[] {
  if (actor === "owner") return ["admin", "operator", "viewer"];
  if (actor === "admin") return ["operator", "viewer"];
  return [];
}
