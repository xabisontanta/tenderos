import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { needsSecondFactor } from "@/lib/auth/mfa";
import { totp } from "../support/totp";
import { admin, env, type Client } from "./helpers";

/**
 * Authenticator apps (TOTP) against the real local Auth server, with the codes computed here (RFC 6238, node:crypto).
 *
 * These run only against a stack whose Auth container was created from a supabase/config.toml that enables
 * `[auth.mfa.totp]`. A container reads that at creation, so a stack started earlier needs `supabase stop` and `supabase start`;
 * a restart is not enough. On a stack without it the whole file is skipped, and says why. What these settle, and what is
 * still unverified without them, is listed in docs/auth.md.
 */
async function newUser(label: string) {
  const email = `${label}-${randomUUID().slice(0, 8)}@tenderos.test`;
  const password = `Pw-${randomUUID()}`;
  const created = await admin().auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const signIn = async (): Promise<Client> => {
    const client = createClient<Database>(env().url, env().anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return client;
  };
  return { id: created.data.user.id, email, password, signIn };
}

/** Does this Auth server accept TOTP enrolment? */
async function totpEnabled(): Promise<boolean> {
  const user = await newUser("mfa-probe");
  const client = await user.signIn();
  const { data, error } = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "probe" });
  if (error) {
    if (error.code === "mfa_totp_enroll_not_enabled") return false;
    throw new Error(`Could not probe TOTP support: ${error.message}`);
  }
  await client.auth.mfa.unenroll({ factorId: data.id });
  return true;
}

const enabled = await totpEnabled();
if (!enabled) {
  console.warn(
    "[mfa.test] SKIPPED: this Auth server has TOTP switched off (GOTRUE_MFA_TOTP_ENROLL_ENABLED=false). supabase/config.toml enables it; recreate the stack's Auth container (supabase stop, supabase start) to run these.",
  );
}

/** Verifies with the current code, allowing for the 30 second step having just rolled over. */
async function verifyWith(client: Client, factorId: string, secret: string) {
  let last: Awaited<ReturnType<Client["auth"]["mfa"]["challengeAndVerify"]>> | undefined;
  for (const stepOffset of [0, -1, 1]) {
    last = await client.auth.mfa.challengeAndVerify({ factorId, code: totp(secret, { stepOffset }) });
    if (!last.error) return last;
  }
  return last!;
}

function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

describe.skipIf(!enabled)("TOTP against the real Auth server", () => {
  it("enrols a factor, accepts a code computed here, and the session becomes aal2", async () => {
    const user = await newUser("mfa-enrol");
    const client = await user.signIn();
    expect((await client.auth.mfa.getAuthenticatorAssuranceLevel()).data).toMatchObject({ currentLevel: "aal1", nextLevel: "aal1" });

    const { data, error } = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "Test phone", issuer: "TenderOS" });
    expect(error).toBeNull();
    expect(data!.totp.qr_code.startsWith("data:image/svg+xml;")).toBe(true);
    expect(data!.totp.secret).toMatch(/^[A-Z2-7]+$/);
    expect(data!.totp.uri).toMatch(/^otpauth:\/\/totp\//);

    // Not on until the first code has been checked.
    const before = await client.auth.mfa.listFactors();
    expect(before.data!.all.map((f) => [f.id, f.status])).toEqual([[data!.id, "unverified"]]);
    expect(before.data!.totp).toEqual([]);
    expect((await client.auth.mfa.getAuthenticatorAssuranceLevel()).data!.nextLevel).toBe("aal1");

    const verified = await verifyWith(client, data!.id, data!.totp.secret);
    expect(verified.error).toBeNull();
    const aal = (await client.auth.mfa.getAuthenticatorAssuranceLevel()).data!;
    expect(aal).toMatchObject({ currentLevel: "aal2", nextLevel: "aal2" });
    const session = (await client.auth.getSession()).data.session!;
    expect(claims(session.access_token).aal).toBe("aal2");
    expect(JSON.stringify(claims(session.access_token).amr)).toContain("totp");
    expect((await client.auth.mfa.listFactors()).data!.totp).toHaveLength(1);
  });

  it("makes a new password sign-in aal1 with aal2 next, which is what sends it to /mfa", async () => {
    const user = await newUser("mfa-signin");
    const first = await user.signIn();
    const { data } = await first.auth.mfa.enroll({ factorType: "totp", friendlyName: "Phone" });
    expect((await verifyWith(first, data!.id, data!.totp.secret)).error).toBeNull();

    const second = await user.signIn();
    const aal = (await second.auth.mfa.getAuthenticatorAssuranceLevel()).data!;
    expect(aal.currentLevel).toBe("aal1");
    expect(aal.nextLevel).toBe("aal2");
    expect(needsSecondFactor(aal)).toBe(true);

    // The session that has only a password cannot switch the second step off.
    const refused = await second.auth.mfa.unenroll({ factorId: data!.id });
    expect(refused.error?.code).toBe("insufficient_aal");
    expect((await verifyWith(second, data!.id, data!.totp.secret)).error).toBeNull();
    expect(needsSecondFactor((await second.auth.mfa.getAuthenticatorAssuranceLevel()).data)).toBe(false);
    expect((await second.auth.mfa.unenroll({ factorId: data!.id })).error).toBeNull();
    expect((await second.auth.mfa.listFactors()).data!.all).toEqual([]);
  });

  it("refuses a wrong code with a code the app can explain, and a name already in use", async () => {
    const user = await newUser("mfa-wrong");
    const client = await user.signIn();
    const { data } = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "Phone" });
    const wrong = totp(data!.totp.secret, { stepOffset: 40 });
    const res = await client.auth.mfa.challengeAndVerify({ factorId: data!.id, code: wrong });
    expect(res.error?.code).toBe("mfa_verification_failed");
    const again = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "Phone" });
    expect(again.error?.code).toBe("mfa_factor_name_conflict");
  });

  it("is ended by reset_user_mfa, which is what support runs for a lost device", async () => {
    const user = await newUser("mfa-reset");
    const client = await user.signIn();
    const { data } = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "Phone" });
    expect((await verifyWith(client, data!.id, data!.totp.secret)).error).toBeNull();

    const reset = await admin().rpc("reset_user_mfa", { p_user_id: user.id, p_reference: "REQ-MFA-1" } as never);
    expect(reset.error).toBeNull();
    expect(reset.data).toMatchObject({ factors_removed: 1 });
    expect((await client.auth.getUser()).error).not.toBeNull();

    const fresh = await user.signIn();
    expect((await fresh.auth.mfa.getAuthenticatorAssuranceLevel()).data).toMatchObject({ currentLevel: "aal1", nextLevel: "aal1" });
  });
});
