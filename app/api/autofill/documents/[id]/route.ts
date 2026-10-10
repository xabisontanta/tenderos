import { z } from "zod";
import { attachmentDisposition, safeDocumentMime } from "@/lib/autofill/format";
import { guardAutofill, json, log, noStoreHeaders } from "@/lib/autofill/server";
import { DOCUMENT_BUCKET } from "@/lib/domain/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Browser helper: one company document's file, so the helper can attach it to
 * a portal form. Only verified, in-date documents of this organisation in a
 * category the member's role allows; every download is audited.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const guarded = await guardAutofill(req, "autofill.document", 60, 300);
  if (guarded instanceof Response) return guarded;
  const { admin, caller } = guarded;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return json({ error: "Document not found" }, 404);

  const { data, error } = await admin.rpc("autofill_document_download", { p_token_id: caller.tokenId, p_document_id: id });
  if (error) {
    log.error("autofill document check failed", {
      organisation_id: caller.organisationId,
      pairing_id: caller.tokenId,
      code: error.code,
      message: error.message,
    });
    return json({ error: "TenderOS could not check this document. Try again shortly." }, 500);
  }
  const doc = data?.[0];
  if (!doc) return json({ error: "Document not found" }, 404);

  const { data: blob, error: downloadError } = await admin.storage.from(DOCUMENT_BUCKET).download(doc.storage_path);
  if (downloadError || !blob) {
    log.error("autofill document download failed", { organisation_id: caller.organisationId, pairing_id: caller.tokenId, document_id: id });
    return json({ error: "TenderOS could not read this document from storage." }, 502);
  }
  log.info("autofill document served", { organisation_id: caller.organisationId, pairing_id: caller.tokenId, document_id: id, bytes: blob.size });
  return new Response(blob.stream(), {
    status: 200,
    headers: noStoreHeaders({
      "Content-Type": safeDocumentMime(doc.mime_type),
      "Content-Length": String(blob.size),
      "Content-Disposition": attachmentDisposition(doc.file_name),
    }),
  });
}
