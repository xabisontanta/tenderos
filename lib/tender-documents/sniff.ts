/**
 * What a downloaded tender document really is. The portal's file name and content type are claims; the bytes decide.
 * Only PDFs are read by the AI in this release, so everything else that checks out is recorded as not read yet, and
 * anything whose bytes do not match its name is a failure (usually an HTML error or login page saved as a PDF).
 */

export type FileKind = "pdf" | "docx" | "xlsx" | "zip" | "unknown";
export type DeclaredKind = "pdf" | "docx" | "xlsx" | "zip" | "other" | "undeclared";

const latin1 = new TextDecoder("latin1");

function startsWith(bytes: Uint8Array, signature: number[], at = 0): boolean {
  return bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b);
}

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const PDF_HEADER_WINDOW = 1024;
const ZIP_WINDOW = 256 * 1024;

/** The kind of file the bytes are. A PDF may be preceded by up to 1 KB of junk, as the format allows. */
export function sniffKind(bytes: Uint8Array): FileKind {
  for (let i = 0; i < PDF_HEADER_WINDOW; i++) {
    if (startsWith(bytes, PDF_HEADER, i)) return "pdf";
  }
  if (startsWith(bytes, ZIP_LOCAL) || startsWith(bytes, ZIP_EMPTY)) {
    // Office packages name their main part in the local headers and again in the central directory at the end.
    const window = latin1.decode(bytes.subarray(0, ZIP_WINDOW)) + latin1.decode(bytes.subarray(Math.max(ZIP_WINDOW, bytes.length - ZIP_WINDOW)));
    if (window.includes("word/document.xml")) return "docx";
    if (window.includes("xl/workbook.xml")) return "xlsx";
    return "zip";
  }
  return "unknown";
}

/** What the file name says the file is. A name with no usable extension is "undeclared": the bytes decide. */
export function declaredKind(fileName: string): DeclaredKind {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(fileName.trim());
  if (!match) return "undeclared";
  switch (match[1].toLowerCase()) {
    case "pdf":
      return "pdf";
    case "docx":
      return "docx";
    case "xlsx":
      return "xlsx";
    case "zip":
      return "zip";
    default:
      return "other";
  }
}

export type DownloadClass =
  { outcome: "pdf" } | { outcome: "unsupported"; kind: FileKind | "other"; message: string } | { outcome: "mismatch"; message: string };

const KIND_LABEL: Record<string, string> = {
  docx: "A Word document",
  xlsx: "An Excel workbook",
  zip: "A zip file",
  other: "This type of file",
  unknown: "This file",
};

const unsupported = (kind: FileKind | "other"): DownloadClass => ({
  outcome: "unsupported",
  kind,
  message: `${KIND_LABEL[kind]} is not read yet; only PDFs are. Open it on the portal and check it yourself`,
});

/** Checks the downloaded bytes against the declared type. */
export function classifyDownload(fileName: string, bytes: Uint8Array): DownloadClass {
  const declared = declaredKind(fileName);
  if (declared === "other") return unsupported("other");
  const actual = sniffKind(bytes);
  switch (declared) {
    case "pdf":
      return actual === "pdf"
        ? { outcome: "pdf" }
        : { outcome: "mismatch", message: "The portal did not send a PDF: the file is not a PDF, although its name says it is" };
    case "docx":
    case "xlsx":
      return actual === declared
        ? unsupported(declared)
        : { outcome: "mismatch", message: `The file is not a real ${declared === "docx" ? "Word" : "Excel"} document, although its name says it is` };
    case "zip":
      return actual === "zip" || actual === "docx" || actual === "xlsx"
        ? unsupported(actual)
        : { outcome: "mismatch", message: "The file is not a zip file, although its name says it is" };
    default:
      return actual === "pdf" ? { outcome: "pdf" } : unsupported(actual);
  }
}

export interface PdfFacts {
  /** The pages the page tree says it has; null when it cannot be read from the file (compressed object streams). */
  pageCount: number | null;
  /** The file asks for a password (an /Encrypt entry in a trailer), so a model could not read it. */
  encrypted: boolean;
}

export function pdfFacts(bytes: Uint8Array): PdfFacts {
  const ends = latin1.decode(bytes.subarray(0, 4096)) + "\n" + latin1.decode(bytes.subarray(Math.max(4096, bytes.length - 16384)));
  const encrypted = /\/Encrypt\b/.test(ends);
  let pageCount: number | null = null;
  const text = latin1.decode(bytes);
  const tree = /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g;
  for (let m = tree.exec(text); m; m = tree.exec(text)) {
    const n = Number(m[1] ?? m[2]);
    if (Number.isSafeInteger(n) && (pageCount === null || n > pageCount)) pageCount = n;
  }
  return { pageCount, encrypted };
}

const MAX_NAME = 120;

/** A file name that is safe to store and show: no path, no control or direction-changing characters, no markup, bounded. */
export function displayFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿<>"'`|?*:]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!cleaned) return "document";
  if (cleaned.length <= MAX_NAME) return cleaned;
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(cleaned)?.[0] ?? "";
  return cleaned.slice(0, MAX_NAME - ext.length) + ext;
}
