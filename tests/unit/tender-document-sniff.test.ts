import { describe, expect, it } from "vitest";
import { classifyDownload, declaredKind, displayFileName, pdfFacts, sniffKind } from "@/lib/tender-documents/sniff";
import { makePdfBase64 } from "../eval/pdf";

const bytes = (s: string | number[]) => (typeof s === "string" ? new Uint8Array(Buffer.from(s, "latin1")) : new Uint8Array(s));
const pdf = (lines = ["Invitation to bid"]) => new Uint8Array(Buffer.from(makePdfBase64(lines), "base64"));

/** A zip-shaped file: a local header, the names it holds, and an end-of-central-directory record. */
function zip(...names: string[]): Uint8Array {
  const parts = names.map((n) => `PK\x03\x04\x14\x00\x00\x00\x08\x00${n}`);
  return bytes(`${parts.join("")}PK\x05\x06\x00\x00\x00\x00`);
}

describe("sniffKind: what the bytes are, whatever the file is called", () => {
  it("recognises a PDF from its header", () => {
    expect(sniffKind(pdf())).toBe("pdf");
    expect(sniffKind(bytes("%PDF-1.7\n%âãÏÓ\n"))).toBe("pdf");
  });

  it("allows a few bytes of junk before the PDF header, as the format does, but not a lot", () => {
    expect(sniffKind(bytes(`\r\n\r\n%PDF-1.4\n`))).toBe("pdf");
    expect(sniffKind(bytes(`${" ".repeat(2000)}%PDF-1.4\n`))).toBe("unknown");
  });

  it("tells Word, Excel and plain zip packages apart", () => {
    expect(sniffKind(zip("[Content_Types].xml", "word/document.xml"))).toBe("docx");
    expect(sniffKind(zip("[Content_Types].xml", "xl/workbook.xml"))).toBe("xlsx");
    expect(sniffKind(zip("readme.txt", "drawings/plan.dwg"))).toBe("zip");
  });

  it("finds the package parts even when a big file sits between the header and the directory", () => {
    const filler = new Uint8Array(400_000).fill(0x41);
    const head = bytes("PK\x03\x04\x14\x00\x00\x00\x08\x00[Content_Types].xml");
    const tail = bytes("PK\x01\x02word/document.xmlPK\x05\x06\x00\x00");
    const all = new Uint8Array(head.length + filler.length + tail.length);
    all.set(head, 0);
    all.set(filler, head.length);
    all.set(tail, head.length + filler.length);
    expect(sniffKind(all)).toBe("docx");
  });

  it.each([
    ["an HTML error page", "<!DOCTYPE html><html><body>File not found</body></html>"],
    ["JSON", '{"error":"expired"}'],
    ["plain text", "Hello"],
    ["nothing", ""],
    ["a PDF header that is not at the start", "x".repeat(1500) + "%PDF-1.4"],
  ])("does not mistake %s for a document", (_label, content) => {
    expect(sniffKind(bytes(content))).toBe("unknown");
  });

  it("does not take an executable or an image for a document", () => {
    expect(sniffKind(bytes([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toBe("unknown");
    expect(sniffKind(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("unknown");
  });
});

describe("declaredKind: what the portal says the file is", () => {
  it.each([
    ["Invitation to bid.pdf", "pdf"],
    ["BOQ.PDF", "pdf"],
    ["Specification.docx", "docx"],
    ["Price schedule.xlsx", "xlsx"],
    ["Drawings.zip", "zip"],
    ["Old form.doc", "other"],
    ["Old sheet.xls", "other"],
    ["Plan.dwg", "other"],
    ["Photo.jpg", "other"],
    ["Notes.txt", "other"],
    ["No extension", "undeclared"],
    ["", "undeclared"],
    ["trailing dot.", "undeclared"],
  ])("%s is %s", (name, kind) => expect(declaredKind(name)).toBe(kind));
});

describe("classifyDownload: the declared type must match the bytes", () => {
  it("accepts a PDF that is a PDF and says it is the only type read", () => {
    expect(classifyDownload("Bid.pdf", pdf())).toEqual({ outcome: "pdf" });
  });

  it("fails a file named .pdf that is something else, and says what the portal sent", () => {
    const res = classifyDownload("Bid.pdf", bytes("<html>Please log in</html>"));
    expect(res).toMatchObject({ outcome: "mismatch" });
    expect((res as { message: string }).message).toMatch(/not a PDF/i);
  });

  it("fails a PDF disguised as another type", () => {
    expect(classifyDownload("Specification.docx", pdf())).toMatchObject({ outcome: "mismatch" });
  });

  it("recognises Word, Excel and zip files as real but not read yet", () => {
    expect(classifyDownload("a.docx", zip("word/document.xml"))).toMatchObject({ outcome: "unsupported", kind: "docx" });
    expect(classifyDownload("a.xlsx", zip("xl/workbook.xml"))).toMatchObject({ outcome: "unsupported", kind: "xlsx" });
    expect(classifyDownload("a.zip", zip("a.txt"))).toMatchObject({ outcome: "unsupported", kind: "zip" });
  });

  it("fails a .docx that is not a Word package", () => {
    expect(classifyDownload("a.docx", zip("a.txt"))).toMatchObject({ outcome: "mismatch" });
    expect(classifyDownload("a.xlsx", zip("word/document.xml"))).toMatchObject({ outcome: "mismatch" });
    expect(classifyDownload("a.docx", bytes("not a zip"))).toMatchObject({ outcome: "mismatch" });
  });

  it("lets a plain zip be named .zip only", () => {
    expect(classifyDownload("a.zip", zip("word/document.xml"))).toMatchObject({ outcome: "unsupported", kind: "docx" });
    expect(classifyDownload("a.zip", pdf())).toMatchObject({ outcome: "mismatch" });
  });

  it("goes by the bytes when the portal gave no extension", () => {
    expect(classifyDownload("Bid document", pdf())).toEqual({ outcome: "pdf" });
    expect(classifyDownload("Bid document", zip("a.txt"))).toMatchObject({ outcome: "unsupported" });
    expect(classifyDownload("Bid document", bytes("hello"))).toMatchObject({ outcome: "unsupported" });
  });

  it("does not fetch types it will not read (their bytes cannot be checked)", () => {
    expect(classifyDownload("Plan.dwg", bytes("anything"))).toMatchObject({ outcome: "unsupported", kind: "other" });
  });
});

describe("pdfFacts", () => {
  it("counts pages from the page tree", () => {
    expect(pdfFacts(pdf(["a"])).pageCount).toBe(1);
    expect(pdfFacts(pdf(Array.from({ length: 120 }, (_, i) => `line ${i}`))).pageCount).toBe(3);
  });

  it("does not guess a page count it cannot read", () => {
    expect(pdfFacts(bytes("%PDF-1.5\n1 0 obj\n<< /Type /ObjStm >>\nendobj\n")).pageCount).toBeNull();
  });

  it("notices a password-protected PDF in the trailer", () => {
    const encrypted = bytes("%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< /Size 2 /Root 1 0 R /Encrypt 5 0 R >>\nstartxref\n0\n%%EOF\n");
    expect(pdfFacts(encrypted).encrypted).toBe(true);
    expect(pdfFacts(pdf()).encrypted).toBe(false);
  });
});

describe("displayFileName", () => {
  it("keeps a normal name", () => {
    expect(displayFileName("Invitation to bid (2026).pdf")).toBe("Invitation to bid (2026).pdf");
  });

  it("drops paths, control characters and markup characters, and bounds the length", () => {
    expect(displayFileName("..\\..\\etc/passwd")).toBe("passwd");
    expect(displayFileName("a\u0000b‮c.pdf")).toBe("abc.pdf");
    expect(displayFileName("<script>alert(1)</script>.pdf")).toBe("script.pdf");
    expect(displayFileName("x".repeat(500) + ".pdf").length).toBeLessThanOrEqual(120);
    expect(displayFileName("x".repeat(500) + ".pdf").endsWith(".pdf")).toBe(true);
  });

  it("never returns an empty name", () => {
    expect(displayFileName("")).toBe("document");
    expect(displayFileName("///")).toBe("document");
  });
});
