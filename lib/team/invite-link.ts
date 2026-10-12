import { appUrl } from "@/lib/env";

/** `tinv_` and 64 lower-case hex digits: the form `create_invitation` issues. Anything else is not a token. */
export const INVITE_TOKEN = /^tinv_[a-f0-9]{64}$/;

/** The link in the invitation email. The origin is APP_URL, never a request header. */
export function inviteUrl(token: string, env: Record<string, string | undefined> = process.env): string {
  if (!INVITE_TOKEN.test(token)) throw new Error("Not an invitation token");
  return `${appUrl(env)}/invite/${token}`;
}
