import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOWED_DOCUMENT_MIME, DOCUMENT_TYPES, MAX_DOCUMENT_BYTES } from "@/lib/domain/documents";
import { BASE_CHECKLIST } from "@/agents/compliance/logic";
import { getAgentDefinition } from "@/agents/registry";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261010000010_company_documents.sql"), "utf8");

describe("document types match the database", () => {
  it("doc_type check lists the same keys", () => {
    const check = sql.match(/doc_type in \(([^)]*)\)/)![1];
    const keys = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(keys).toEqual(DOCUMENT_TYPES.map((t) => t.key));
  });

  it("private.document_category maps each key to the same data category", () => {
    const pairs = Object.fromEntries([...sql.matchAll(/when '([a-z_]+)' then '([A-Z_]+)'/g)].map((m) => [m[1], m[2]]));
    expect(pairs).toEqual(Object.fromEntries(DOCUMENT_TYPES.map((t) => [t.key, t.category])));
  });

  it("bucket limits match the upload form", () => {
    expect(sql).toContain(String(MAX_DOCUMENT_BYTES));
    for (const mime of ALLOWED_DOCUMENT_MIME) expect(sql).toContain(`'${mime}'`);
  });
});

describe("documents reach the right agents", () => {
  it("every compliance checklist item can be evidenced by an upload the Compliance Officer may read", () => {
    const compliance = getAgentDefinition("compliance")!;
    for (const item of [...BASE_CHECKLIST, { key: "cidb_grading" }]) {
      const type = DOCUMENT_TYPES.find((t) => t.key === item.key);
      expect(type, item.key).toBeDefined();
      expect(compliance.dataCategories).toContain(type!.category);
    }
  });

  it("banking, director and address documents are only granted to the Document Manager", () => {
    const restricted = DOCUMENT_TYPES.filter((t) => ["BANKING", "DIRECTOR_PERSONAL", "PROOF_OF_ADDRESS"].includes(t.category));
    expect(restricted.map((t) => t.key)).toEqual(["bank_confirmation", "director_ids", "proof_of_address"]);
    for (const slug of ["compliance", "proposal_writer", "submission", "quality_assurance", "pricing"]) {
      for (const t of restricted) expect(getAgentDefinition(slug)!.dataCategories).not.toContain(t.category);
    }
  });
});

describe("document content check", () => {
  it("accepts files whose bytes match the declared type and rejects disguised ones", async () => {
    const { contentMatchesType, canReadDocumentType } = await import("@/lib/domain/documents");
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(contentMatchesType("application/pdf", bytes("%PDF-1.7"))).toBe(true);
    expect(contentMatchesType("application/pdf", bytes("<html><script>"))).toBe(false);
    expect(contentMatchesType("image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(true);
    expect(contentMatchesType("application/vnd.openxmlformats-officedocument.wordprocessingml.document", new Uint8Array([0x50, 0x4b, 3, 4]))).toBe(true);
    expect(contentMatchesType("text/html", bytes("%PDF-1.7"))).toBe(false);
    expect(contentMatchesType(null, bytes("%PDF-1.7"))).toBe(false);
    expect(canReadDocumentType("director_ids", false)).toBe(false);
    expect(canReadDocumentType("director_ids", true)).toBe(true);
    expect(canReadDocumentType("cipc_registration", false)).toBe(true);
  });
});
