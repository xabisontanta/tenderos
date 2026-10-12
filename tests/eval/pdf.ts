/** Wraps text lines at a width so they fit on an A4 page in 10 pt Helvetica. */
function wrap(lines: string[], width = 92): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let rest = line;
    while (rest.length > width) {
      const cut = rest.lastIndexOf(" ", width);
      const at = cut > 40 ? cut : width;
      out.push(rest.slice(0, at));
      rest = rest.slice(at).trimStart();
    }
    out.push(rest);
  }
  return out;
}

const esc = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7e]/g, "?");

/**
 * A minimal one-page-per-50-lines PDF with a real text layer, base64 encoded,
 * so the live evaluation can send the PDF document block path a genuine file.
 * No dependency: plain objects, a computed cross-reference table.
 */
export function makePdfBase64(lines: string[]): string {
  const wrapped = wrap(lines);
  const perPage = 50;
  const pages: string[][] = [];
  for (let i = 0; i < wrapped.length; i += perPage) pages.push(wrapped.slice(i, i + perPage));
  if (pages.length === 0) pages.push([""]);

  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((pageLines, i) => {
    const pageId = 4 + i * 2;
    const contentId = pageId + 1;
    const stream = `BT /F1 10 Tf 50 800 Td 14 TL ${pageLines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, "latin1").toString("base64");
}
