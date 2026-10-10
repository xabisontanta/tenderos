import type { Metadata } from "next";
import { ResetPasswordForm } from "@/features/auth/password-forms";

export const metadata: Metadata = { title: "Choose a new password" };

// Reached from the emailed reset link, which signs the user in first.
export default function ResetPasswordPage() {
  return (
    <>
      <h2 className="mb-4 text-sm font-semibold">Choose a new password</h2>
      <ResetPasswordForm />
    </>
  );
}
