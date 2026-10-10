"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn, signUp, type FormState } from "./actions";

export function AuthForm({ mode, next }: { mode: "login" | "signup"; next?: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(mode === "login" ? signIn : signUp, {});
  return (
    <form action={action} className="grid gap-4" noValidate>
      {mode === "signup" && (
        <div className="grid gap-1.5">
          <Label htmlFor="fullName">Full name</Label>
          <Input id="fullName" name="fullName" autoComplete="name" required />
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required />
        {mode === "signup" && <p className="text-[11px] text-muted-foreground">At least 12 characters, with a letter and a number.</p>}
      </div>
      {next && <input type="hidden" name="next" value={next} />}
      {state.error && (
        <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {state.error}
        </p>
      )}
      {state.message && (
        <p role="status" className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          {state.message}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        {mode === "login" ? (
          <>
            No account?{" "}
            <Link className="text-primary hover:underline" href="/signup">
              Create one
            </Link>
          </>
        ) : (
          <>
            Already registered?{" "}
            <Link className="text-primary hover:underline" href="/login">
              Sign in
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
