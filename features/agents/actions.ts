"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { toUserError, type ActionResult } from "@/lib/actions";

const schema = z.object({
  agentId: z.string().uuid(),
  action: z.enum(["pause", "resume", "disable", "enable"]),
  reason: z.string().trim().max(300).optional(),
});

export async function controlAgent(input: z.input<typeof schema>): Promise<ActionResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request" };
  const supabase = await getServerSupabase();
  const { error } = await supabase.rpc("set_agent_control", {
    p_agent_id: parsed.data.agentId,
    p_action: parsed.data.action,
    p_reason: parsed.data.reason || undefined,
  });
  if (error) return { ok: false, error: toUserError(error, "Could not update the agent") };
  revalidatePath(`/agents/${parsed.data.agentId}`);
  return { ok: true };
}
