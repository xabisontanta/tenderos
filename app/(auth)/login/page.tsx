import type { Metadata } from "next";
import { AuthForm } from "@/features/auth/auth-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <>
      <h2 className="mb-4 text-sm font-semibold">Sign in</h2>
      <AuthForm mode="login" next={next} />
    </>
  );
}
