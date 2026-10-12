"use client";

import { useEffect } from "react";
import { Logo } from "@/components/command-centre/logo";
import { Button } from "@/components/ui/button";

/**
 * Catches failures in the app layout itself (for example the header's queries),
 * which the (app) segment's own boundary cannot. Shows only a reference code:
 * Next redacts server error messages in production and the digest links to logs.
 */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm text-center">
        <Logo className="mx-auto size-10" />
        <h1 className="mt-6 text-lg font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          TenderOS could not load this page. Your work is safe. Try again, and if it keeps happening contact support with the reference below.
        </p>
        {error.digest && <p className="mt-3 font-mono text-[11px] text-muted-foreground">Reference: {error.digest}</p>}
        <Button className="mt-6" variant="outline" onClick={reset}>
          Try again
        </Button>
      </div>
    </main>
  );
}
