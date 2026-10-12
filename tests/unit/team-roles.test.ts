import { describe, expect, it } from "vitest";
import { ORG_ROLES, ROLE_DESCRIPTIONS, canRemoveMember, selectableRoles, type OrgRole } from "@/lib/team/roles";

describe("role descriptions", () => {
  it("describes every role in plain words, and the viewer as read-only for auditors and accountants", () => {
    expect(Object.keys(ROLE_DESCRIPTIONS).sort()).toEqual([...ORG_ROLES].sort());
    expect(ROLE_DESCRIPTIONS.owner.label).toBe("Owner");
    expect(ROLE_DESCRIPTIONS.viewer.summary).toMatch(/read-only/i);
    expect(ROLE_DESCRIPTIONS.viewer.summary).toMatch(/auditors and accountants/i);
    for (const role of ORG_ROLES) expect(ROLE_DESCRIPTIONS[role].summary.length).toBeGreaterThan(20);
  });
});

describe("selectableRoles: what the role menu offers, mirroring change_member_role", () => {
  it("offers an owner every role for every member", () => {
    for (const target of ORG_ROLES) expect(selectableRoles("owner", target)).toEqual(["owner", "admin", "operator", "viewer"]);
  });

  it("keeps owners out of an admin's reach, and admin and owner out of what an admin may hand out", () => {
    expect(selectableRoles("admin", "owner")).toEqual([]);
    expect(selectableRoles("admin", "operator")).toEqual(["operator", "viewer"]);
    expect(selectableRoles("admin", "viewer")).toEqual(["operator", "viewer"]);
    // An admin can step another admin down, but a menu that includes "admin" only shows the current value.
    expect(selectableRoles("admin", "admin")).toEqual(["admin", "operator", "viewer"]);
  });

  it.each<OrgRole>(["operator", "viewer"])("offers a %s nothing", (actor) => {
    for (const target of ORG_ROLES) expect(selectableRoles(actor, target)).toEqual([]);
  });
});

describe("canRemoveMember, mirroring remove_member", () => {
  it("lets owners remove anyone, and admins anyone but an owner", () => {
    for (const target of ORG_ROLES) expect(canRemoveMember("owner", target, false)).toBe(true);
    expect(canRemoveMember("admin", "owner", false)).toBe(false);
    expect(canRemoveMember("admin", "admin", false)).toBe(true);
    expect(canRemoveMember("admin", "operator", false)).toBe(true);
  });

  it("lets every member leave, but operators and viewers remove nobody else", () => {
    for (const role of ORG_ROLES) expect(canRemoveMember(role, role, true)).toBe(true);
    expect(canRemoveMember("operator", "viewer", false)).toBe(false);
    expect(canRemoveMember("viewer", "viewer", false)).toBe(false);
  });
});
