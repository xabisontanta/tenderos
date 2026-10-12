import { z } from "zod";
import { applyReportSchema } from "@/lib/autofill/apply-plan";
import { guardAutofill, json, log } from "@/lib/autofill/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2000;

/**
 * Browser helper, "Apply with TenderOS": the helper reports that it prepared
 * the portal form (host and counts only) so the tender page can say so. This
 * records an audit event; it submits nothing and changes no tender state.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const guarded = await guardAutofill(req, "autofill.apply_report", 30, 3600);
  if (guarded instanceof Response) return guarded;
  const { admin, caller } = guarded;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return json({ error: "Tender not found" }, 404);
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json({ error: "Send the report as JSON" }, 415);

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json({ error: "Report too large" }, 413);
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Report too large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid report" }, 422);
  }
  const parsed = applyReportSchema.safeParse(body);
  if (!parsed.success) return json({ error: "Invalid report" }, 422);
  const report = parsed.data;

  const { error } = await admin.rpc("autofill_record_prepared", {
    p_token_id: caller.tokenId,
    p_tender_id: id,
    p_host: report.host,
    p_fields: report.fields,
    p_documents: report.documents,
    p_left: report.left,
    p_sensitive: report.sensitive,
    p_confirmed_host: report.confirmed_host,
  });
  if (error) {
    if (error.code === "P0429") return json({ error: "Too many requests; wait a while and try again" }, 429, { "Retry-After": "3600" });
    if (error.code === "23514") return json({ error: "This tender has no approved bid waiting for delivery" }, 409);
    if (error.code === "42501") return json({ error: "Not allowed" }, 403);
    log.error("autofill apply report failed", {
      organisation_id: caller.organisationId,
      pairing_id: caller.tokenId,
      tender_id: id,
      code: error.code,
      message: error.message,
    });
    return json({ error: "TenderOS could not record this. Try again shortly." }, 500);
  }
  log.info("autofill apply reported", {
    organisation_id: caller.organisationId,
    pairing_id: caller.tokenId,
    tender_id: id,
    fields: report.fields,
    documents: report.documents,
  });
  return json({ ok: true });
}
