import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/features/auth/password-forms";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <>
      <h2 className="mb-4 text-sm font-semibold">Reset your password</h2>
      <ForgotPasswordForm />
    </>
  );
}
