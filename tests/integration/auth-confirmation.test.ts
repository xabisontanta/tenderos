import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { admin, env } from "./helpers";
import { mailboxReachable, pickLink, waitForMail } from "../e2e/helpers/mailbox";

/**
 * The mechanics behind email confirmation, against the real local Auth service
 * and mail catcher. Whether the stack itself requires confirmation is set by
 * supabase/config.toml when the stack starts; these tests create the
 * unconfirmed users explicitly, so they hold either way.
 */

const anon = () => createClient<Database>(env().url, env().anon, { auth: { persistSession: false, autoRefreshToken: false } });

async function unconfirmedUser() {
  const email = `confirm-${randomUUID().slice(0, 8)}@tenderos.test`;
  const password = `Pw-${randomUUID()}`;
  const { data, error } = await admin().auth.admin.createUser({ email, password, email_confirm: false });
  if (error) throw error;
  return { id: data.user.id, email, password };
}

describe("an unconfirmed address", () => {
  it("cannot sign in, and Auth says why", async () => {
    const user = await unconfirmedUser();
    const { error } = await anon().auth.signInWithPassword({ email: user.email, password: user.password });
    expect(error?.code).toBe("email_not_confirmed");
  });

  it("is sent a confirmation email on request, and its link confirms the address", async () => {
    expect(await mailboxReachable(), "the mail catcher must be reachable (see MAILBOX_URL)").toBe(true);
    const user = await unconfirmedUser();
    const { error } = await anon().auth.resend({
      type: "signup",
      email: user.email,
      options: { emailRedirectTo: "http://127.0.0.1:3000/auth/callback?next=%2Fonboarding" },
    });
    expect(error).toBeNull();

    const mail = await waitForMail(user.email, { subject: /confirm/i });
    expect(mail.to).toContain(user.email);
    const link = pickLink(mail, /\/auth\/(confirm\?token_hash=|v1\/verify)/);
    if (link.includes("/auth/confirm?")) {
      // The branded template links to the app's /auth/confirm route, which verifies the
      // token hash. Do the same here, from a client that never started the flow.
      const url = new URL(link);
      expect(url.searchParams.get("type")).toBe("email");
      expect(url.searchParams.get("next")).toBe("/onboarding");
      const verified = await anon().auth.verifyOtp({ type: "email", token_hash: url.searchParams.get("token_hash")! });
      expect(verified.error).toBeNull();
    } else {
      // Supabase's default template: the link itself does the confirming. Do not follow the redirect.
      const res = await fetch(link, { redirect: "manual" });
      expect([301, 302, 303, 307]).toContain(res.status);
    }

    const { data } = await admin().auth.admin.getUserById(user.id);
    expect(data.user?.email_confirmed_at).toBeTruthy();
    expect((await anon().auth.signInWithPassword({ email: user.email, password: user.password })).error).toBeNull();
  });
});

describe("token_hash links (what /auth/confirm verifies)", () => {
  it("confirm an address from a browser that never started the flow, once", async () => {
    const user = await unconfirmedUser();
    const { data, error } = await admin().auth.admin.generateLink({ type: "magiclink", email: user.email });
    expect(error).toBeNull();
    const tokenHash = data!.properties!.hashed_token;

    // A brand-new client has no PKCE verifier, like a phone opening the emailed link.
    const fresh = anon();
    const verified = await fresh.auth.verifyOtp({ type: "email", token_hash: tokenHash });
    expect(verified.error).toBeNull();
    expect(verified.data.session?.access_token).toBeTruthy();
    expect(verified.data.user?.email_confirmed_at).toBeTruthy();

    // The hash is single-use.
    expect((await anon().auth.verifyOtp({ type: "email", token_hash: tokenHash })).error).not.toBeNull();
  });

  it("start a password reset the same way", async () => {
    const user = await unconfirmedUser();
    await admin().auth.admin.updateUserById(user.id, { email_confirm: true });
    const { data } = await admin().auth.admin.generateLink({ type: "recovery", email: user.email });
    const verified = await anon().auth.verifyOtp({ type: "recovery", token_hash: data!.properties!.hashed_token });
    expect(verified.error).toBeNull();
    expect(verified.data.session).toBeTruthy();
  });

  it("are refused when forged, truncated or of the wrong type", async () => {
    const user = await unconfirmedUser();
    const { data } = await admin().auth.admin.generateLink({ type: "magiclink", email: user.email });
    const hash = data!.properties!.hashed_token;
    expect((await anon().auth.verifyOtp({ type: "email", token_hash: `${hash.slice(0, -2)}xx` })).error).not.toBeNull();
    expect((await anon().auth.verifyOtp({ type: "email", token_hash: "0".repeat(64) })).error).not.toBeNull();
    // (Auth keeps magic-link and recovery hashes in one column, so those two types
    // are interchangeable to it; a type of another kind is not.)
    expect((await anon().auth.verifyOtp({ type: "email_change", token_hash: hash })).error).not.toBeNull();
  });
});
