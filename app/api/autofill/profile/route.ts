import { guardAutofill, json, loadAutofillPayload, log } from "@/lib/autofill/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Browser helper: the company details, attachable documents (metadata only)
 * and bids awaiting delivery for the member whose pairing code this is.
 */
export async function GET(req: Request): Promise<Response> {
  const guarded = await guardAutofill(req, "autofill.profile", 30, 60);
  if (guarded instanceof Response) return guarded;
  const { admin, caller } = guarded;
  try {
    const payload = await loadAutofillPayload(admin, caller);
    log.info("autofill profile served", {
      organisation_id: caller.organisationId,
      pairing_id: caller.tokenId,
      documents: payload.documents.length,
      bids: payload.bids.length,
    });
    return json(payload);
  } catch (err) {
    log.error("autofill profile failed", { organisation_id: caller.organisationId, pairing_id: caller.tokenId, error: (err as Error).message });
    return json({ error: "TenderOS could not load your company details. Try again shortly." }, 500);
  }
}
