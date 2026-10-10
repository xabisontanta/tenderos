"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { rateLimit, toUserError, type ActionResult } from "@/lib/actions";

const schema = z.object({
  approvalId: z.string().uuid(),
  approve: z.boolean(),
  comments: z.string().trim().max(2000).optional(),
});

export async function decideApproval(input: z.input<typeof schema>): Promise<ActionResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request" };
  if (!parsed.data.approve && (parsed.data.comments ?? "").length < 3) return { ok: false, error: "Give a reason for rejecting" };
  const supabase = await getServerSupabase();
  const limited = await rateLimit(supabase, "approval.decide", 30, 60);
  if (limited) return { ok: false, error: limited };
  const { error } = await supabase.rpc("decide_approval", {
    p_approval_id: parsed.data.approvalId,
    p_approve: parsed.data.approve,
    p_comments: parsed.data.comments || undefined,
  });
  if (error) return { ok: false, error: toUserError(error, "Could not record the decision") };
  revalidatePath("/approvals");
  return { ok: true };
}
