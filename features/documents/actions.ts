"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { canAdminister, canOperate, requireContext } from "@/lib/data/context";
import { requireAal2 } from "@/lib/auth/require-aal2";
import { toUserError, type ActionResult } from "@/lib/actions";
import { DOCUMENT_BUCKET, DOCUMENT_TYPES, contentMatchesType } from "@/lib/domain/documents";
import { createLogger } from "@/lib/log";

const log = createLogger({ service: "web.documents" });

const registerSchema = z.object({
  docType: z.enum(DOCUMENT_TYPES.map((t) => t.key) as [string, ...string[]]),
  title: z.string().trim().min(2, "Give the document a name").max(200),
  path: z.string().min(1).max(500),
  expiresAt: z.iso.date("Use a date").nullable(),
});

/** Records a file the browser has already uploaded to the organisation's folder in Storage. */
export async function registerDocument(input: z.input<typeof registerSchema>): Promise<ActionResult> {
  const ctx = await requireContext();
  if (!canOperate(ctx.role)) return { ok: false, error: "Viewers cannot upload documents" };
  const verify = await requireAal2(ctx);
  if (verify) return { ok: false, error: verify };
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  if (!parsed.data.path.startsWith(`${ctx.organisation.id}/`) || parsed.data.path.includes("..")) return { ok: false, error: "Invalid upload" };
  const supabase = await getServerSupabase();

  // The bucket only accepts listed content types, but the type is whatever the
  // browser declared. Check the file really is that type before keeping it.
  const admin = getAdminSupabase();
  const { data: blob } = await admin.storage.from(DOCUMENT_BUCKET).download(parsed.data.path);
  const head = blob ? new Uint8Array(await blob.slice(0, 8).arrayBuffer()) : new Uint8Array();
  if (!blob || !contentMatchesType(blob.type || null, head)) {
    await admin.storage.from(DOCUMENT_BUCKET).remove([parsed.data.path]);
    log.warn("document rejected: content does not match type", { organisation_id: ctx.organisation.id, declared: blob?.type ?? null });
    return { ok: false, error: "That file is not a real PDF, image, Word or Excel file. Export it again and upload the new copy." };
  }

  const { error } = await supabase.rpc("register_company_document", {
    p_org: ctx.organisation.id,
    p_doc_type: parsed.data.docType,
    p_title: parsed.data.title,
    p_path: parsed.data.path,
    p_expires_at: parsed.data.expiresAt ?? undefined,
  });
  if (error) return { ok: false, error: toUserError(error, "Could not save the document") };
  revalidatePath("/documents");
  return { ok: true };
}

const idSchema = z.string().uuid();

export async function verifyDocument(id: string): Promise<ActionResult> {
  const ctx = await requireContext();
  if (!canAdminister(ctx.role)) return { ok: false, error: "Only owners and admins can verify documents" };
  if (!idSchema.safeParse(id).success) return { ok: false, error: "Invalid document" };
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("verify_company_document", { p_id: id });
  if (error) return { ok: false, error: toUserError(error, "Could not verify the document") };
  revalidatePath("/documents");
  return { ok: true };
}

export async function archiveDocument(id: string): Promise<ActionResult> {
  const ctx = await requireContext();
  if (!canAdminister(ctx.role)) return { ok: false, error: "Only owners and admins can remove documents" };
  if (!idSchema.safeParse(id).success) return { ok: false, error: "Invalid document" };
  const supabase = await getServerSupabase();
  const { data: doc } = await supabase.from("company_documents").select("storage_path").eq("id", id).maybeSingle();
  const { error } = await supabase.rpc("archive_company_document", { p_id: id });
  if (error) return { ok: false, error: toUserError(error, "Could not remove the document") };
  // The record stays for the audit trail; the file itself is deleted.
  if (doc) {
    const { error: removeError } = await getAdminSupabase().storage.from(DOCUMENT_BUCKET).remove([doc.storage_path]);
    if (removeError) log.error("archived document file not deleted", { organisation_id: ctx.organisation.id, document_id: id });
  }
  revalidatePath("/documents");
  return { ok: true };
}

/**
 * A 60-second, download-only link to one document. The database checks the
 * member may open it (restricted categories need an owner or admin) and
 * records the access before the link is signed.
 */
export async function documentDownloadUrl(id: string): Promise<ActionResult<string>> {
  await requireContext();
  if (!idSchema.safeParse(id).success) return { ok: false, error: "Invalid document" };
  const supabase = await getServerSupabase();
  const { data, error } = await supabase.rpc("document_download", { p_id: id });
  const doc = data?.[0];
  if (error || !doc) return { ok: false, error: toUserError(error, "You cannot open this document") };
  const { data: signed, error: signError } = await supabase.storage.from(DOCUMENT_BUCKET).createSignedUrl(doc.storage_path, 60, { download: doc.file_name });
  if (signError || !signed) return { ok: false, error: "Could not prepare the download" };
  return { ok: true, data: signed.signedUrl };
}
