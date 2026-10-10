"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { canAdminister, canOperate, requireContext } from "@/lib/data/context";
import { toUserError, type ActionResult } from "@/lib/actions";
import { DOCUMENT_TYPES } from "@/lib/domain/documents";

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
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  if (!parsed.data.path.startsWith(`${ctx.organisation.id}/`)) return { ok: false, error: "Invalid upload" };
  const supabase = await getServerSupabase();
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
  const { error } = await supabase.rpc("archive_company_document", { p_id: id });
  if (error) return { ok: false, error: toUserError(error, "Could not remove the document") };
  revalidatePath("/documents");
  return { ok: true };
}
