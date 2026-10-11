import type { Metadata } from "next";
import { AuthForm } from "@/features/auth/auth-form";
import { Feedback } from "@/features/auth/form-parts";
import { captchaClientConfig } from "@/lib/auth/captcha-config";

export const metadata: Metadata = { title: "Sign in" };

const LINK_PROBLEM =
  "That link has expired or was already used. If you have not confirmed your email yet, sign in and we will offer to send a new link. If you were resetting your password, ask for a new reset link.";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <>
      <h2 className="mb-4 text-sm font-semibold">Sign in</h2>
      {error === "link_invalid" && (
        <div className="mb-4 grid">
          <Feedback state={{ error: LINK_PROBLEM }} />
        </div>
      )}
      <AuthForm mode="login" next={next} captcha={captchaClientConfig()} />
    </>
  );
}
