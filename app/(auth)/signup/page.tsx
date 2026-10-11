import type { Metadata } from "next";
import { AuthForm } from "@/features/auth/auth-form";
import { captchaClientConfig } from "@/lib/auth/captcha-config";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <>
      <h2 className="mb-4 text-sm font-semibold">Create your account</h2>
      <AuthForm mode="signup" captcha={captchaClientConfig()} />
    </>
  );
}
