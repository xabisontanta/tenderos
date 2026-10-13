import { z } from "zod";
import { guardAutofill, json, loadApplyPlan, log } from "@/lib/autofill/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Browser helper, "Apply with TenderOS": the portal address, the company
 * facts and the approved bid pack documents for one tender, so the helper can
 * open the portal and prepare its form. Authenticated by the pairing code,
 * limited to the code's organisation and to approved real bids still awaiting
 * delivery. Personal documents are included only for owners and admins who
 * ask (`?sensitive=1`). The person still submits; nothing is sent from here.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const guarded = await guardAutofill(req, "autofill.apply_plan", 20, 300);
  if (guarded instanceof Response) return guarded;
  const { admin, caller } = guarded;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return json({ error: "Tender not found" }, 404);
  const includeSensitive = new URL(req.url).searchParams.get("sensitive") === "1";

  try {
    const found = await loadApplyPlan(admin, caller, id, includeSensitive);
    switch (found.kind) {
      case "not_found":
        return json({ error: "Tender not found" }, 404);
      case "not_ready":
        return json({ error: found.message }, 409);
      case "no_portal":
        return json({ error: found.message }, 422);
      case "ok":
        log.info("autofill apply plan served", {
          organisation_id: caller.organisationId,
          pairing_id: caller.tokenId,
          tender_id: id,
          documents: found.plan.documents.length,
          sensitive: found.plan.include_sensitive,
        });
        return json(found.plan);
    }
  } catch (err) {
    log.error("autofill apply plan failed", {
      organisation_id: caller.organisationId,
      pairing_id: caller.tokenId,
      tender_id: id,
      error: (err as Error).message,
    });
    return json({ error: "TenderOS could not prepare this tender. Try again shortly." }, 500);
  }
}
