import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { eraseOrganisation, eraseUser, exportOrganisationData, exportUserData, listFiles, resetUserMfa } from "@/lib/privacy/erasure";

type Entry = { name: string; id: string | null };

/** A Storage bucket as a tree: folders map to entries; an entry with an id is a file. */
function fakeAdmin(opts: {
  tree: Record<string, Entry[]>;
  /** The tender-documents bucket's tree. Empty unless given. */
  tenderTree?: Record<string, Entry[]>;
  rpc?: (name: string, args: unknown) => { data: unknown; error: { message: string } | null };
  removeError?: boolean;
}) {
  const calls: string[] = [];
  const removed: string[][] = [];
  const removedFrom: string[] = [];
  const makeBucket = (name: string, tree: Record<string, Entry[]>) => ({
    list: vi.fn(async (folder: string, o: { limit: number; offset: number }) => {
      calls.push(`list:${folder}:${o.offset}`);
      return { data: (tree[folder] ?? []).slice(o.offset, o.offset + o.limit), error: null };
    }),
    remove: vi.fn(async (paths: string[]) => {
      calls.push("remove");
      removed.push(paths);
      removedFrom.push(name);
      return opts.removeError ? { data: null, error: { message: "storage down" } } : { data: [], error: null };
    }),
  });
  const bucket = makeBucket("company-documents", opts.tree);
  const tenderBucket = makeBucket("tender-documents", opts.tenderTree ?? {});
  const rpc = vi.fn(async (name: string, args: unknown) => {
    calls.push(`rpc:${name}`);
    return opts.rpc ? opts.rpc(name, args) : { data: {}, error: null };
  });
  const admin = { storage: { from: (name: string) => (name === "tender-documents" ? tenderBucket : bucket) }, rpc } as unknown as SupabaseClient<Database>;
  return { admin, calls, removed, removedFrom, bucket, rpc };
}

const ORG = "11111111-1111-1111-1111-111111111111";

describe("listFiles", () => {
  it("follows folders and returns every file, including uploads nobody registered", async () => {
    const { admin } = fakeAdmin({
      tree: {
        [ORG]: [
          { name: "doc-a", id: null },
          { name: "doc-b", id: null },
        ],
        [`${ORG}/doc-a`]: [{ name: "cipc.pdf", id: "f1" }],
        [`${ORG}/doc-b`]: [
          { name: "tax.pdf", id: "f2" },
          { name: "nested", id: null },
        ],
        [`${ORG}/doc-b/nested`]: [{ name: "deep.pdf", id: "f3" }],
      },
    });
    expect((await listFiles(admin, ORG)).sort()).toEqual([`${ORG}/doc-a/cipc.pdf`, `${ORG}/doc-b/nested/deep.pdf`, `${ORG}/doc-b/tax.pdf`]);
  });

  it("pages through a folder with more than one page of files", async () => {
    const many: Entry[] = Array.from({ length: 1500 }, (_, i) => ({ name: `f${i}.pdf`, id: `id${i}` }));
    const { admin } = fakeAdmin({ tree: { [ORG]: many } });
    expect(await listFiles(admin, ORG)).toHaveLength(1500);
  });

  it("fails loudly when Storage cannot list", async () => {
    const admin = { storage: { from: () => ({ list: async () => ({ data: null, error: { message: "boom" } }) }) } } as unknown as SupabaseClient<Database>;
    await expect(listFiles(admin, ORG)).rejects.toThrow(/Could not list stored files/);
  });
});

describe("eraseOrganisation", () => {
  it("removes the files first, then erases the rows, and reports how many files went", async () => {
    const { admin, calls, removed } = fakeAdmin({
      tree: { [ORG]: [{ name: "d1", id: null }], [`${ORG}/d1`]: [{ name: "a.pdf", id: "x" }] },
      rpc: () => ({ data: { erased: "organisation", organisation_id: ORG, members_erased: 2, documents_erased: 1, reference: "REQ-1" }, error: null }),
    });
    const res = await eraseOrganisation(admin, ORG, { reference: "REQ-1" });
    expect(removed).toEqual([[`${ORG}/d1/a.pdf`]]);
    expect(calls.indexOf("remove")).toBeLessThan(calls.indexOf("rpc:erase_organisation"));
    expect(res).toMatchObject({ erased: "organisation", members_erased: 2, files_removed: 1 });
  });

  it("removes the organisation's fetched tender documents too, before the rows go", async () => {
    const { admin, calls, removed, removedFrom } = fakeAdmin({
      tree: { [ORG]: [{ name: "a.pdf", id: "x" }] },
      tenderTree: { [ORG]: [{ name: "t1", id: null }], [`${ORG}/t1`]: [{ name: "abc.pdf", id: "y" }] },
      rpc: () => ({ data: { erased: "organisation", organisation_id: ORG, members_erased: 1, documents_erased: 1, reference: null }, error: null }),
    });
    const res = await eraseOrganisation(admin, ORG);
    expect(removedFrom.sort()).toEqual(["company-documents", "tender-documents"]);
    expect(removed.flat().sort()).toEqual([`${ORG}/a.pdf`, `${ORG}/t1/abc.pdf`]);
    expect(calls.lastIndexOf("remove")).toBeLessThan(calls.indexOf("rpc:erase_organisation"));
    expect(res.files_removed).toBe(2);
  });

  it("does not touch the database when files could not be removed, so the request can be run again", async () => {
    const { admin, rpc } = fakeAdmin({ tree: { [ORG]: [{ name: "a.pdf", id: "x" }] }, removeError: true });
    await expect(eraseOrganisation(admin, ORG)).rejects.toThrow(/Could not remove stored files/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("removes files in chunks", async () => {
    const files: Entry[] = Array.from({ length: 250 }, (_, i) => ({ name: `f${i}.pdf`, id: `id${i}` }));
    const { admin, removed } = fakeAdmin({ tree: { [ORG]: files } });
    await eraseOrganisation(admin, ORG);
    expect(removed.map((r) => r.length)).toEqual([100, 100, 50]);
  });

  it("reports a database failure", async () => {
    const { admin } = fakeAdmin({ tree: {}, rpc: () => ({ data: null, error: { message: "Organisation not found" } }) });
    await expect(eraseOrganisation(admin, ORG)).rejects.toThrow(/Could not erase the organisation: Organisation not found/);
  });
});

describe("resetUserMfa", () => {
  it("passes the user and the ticket reference to the database function and returns its counts", async () => {
    const { admin, rpc } = fakeAdmin({ tree: {}, rpc: () => ({ data: { factors_removed: 1, sessions_ended: 3, reference: "REQ-7" }, error: null }) });
    expect(await resetUserMfa(admin, "u1", { reference: "REQ-7" })).toEqual({ factors_removed: 1, sessions_ended: 3, reference: "REQ-7" });
    expect(rpc).toHaveBeenCalledWith("reset_user_mfa", { p_user_id: "u1", p_reference: "REQ-7" });
  });

  it("surfaces a database error instead of pretending the person was reset", async () => {
    const { admin } = fakeAdmin({ tree: {}, rpc: () => ({ data: null, error: { message: "User not found" } }) });
    await expect(resetUserMfa(admin, "u1", { reference: "REQ-7" })).rejects.toThrow(/Could not reset the authenticator: User not found/);
  });
});

describe("eraseUser and the exports", () => {
  it("pass the reference and actor to the database functions", async () => {
    const { admin, rpc } = fakeAdmin({ tree: {}, rpc: () => ({ data: { erased: "user", pseudonym: "erased-ab12cd34" }, error: null }) });
    expect(await eraseUser(admin, "u1", { reference: "REQ-9" })).toMatchObject({ pseudonym: "erased-ab12cd34" });
    expect(rpc).toHaveBeenCalledWith("erase_user", { p_user_id: "u1", p_reference: "REQ-9" });
    await exportUserData(admin, "u1", "operator-1");
    expect(rpc).toHaveBeenCalledWith("export_user_data", { p_user_id: "u1", p_actor: "operator-1" });
    await exportOrganisationData(admin, ORG, "owner-1");
    expect(rpc).toHaveBeenCalledWith("export_organisation_data", { p_org: ORG, p_actor: "owner-1" });
  });

  it("surface database errors instead of returning empty data", async () => {
    const { admin } = fakeAdmin({ tree: {}, rpc: () => ({ data: null, error: { message: "denied" } }) });
    await expect(eraseUser(admin, "u1")).rejects.toThrow(/Could not erase the user: denied/);
    await expect(exportUserData(admin, "u1")).rejects.toThrow(/Could not export/);
    await expect(exportOrganisationData(admin, ORG)).rejects.toThrow(/Could not export/);
  });
});
