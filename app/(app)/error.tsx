"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/** Shows the failure plainly instead of hiding it; the digest links to server logs. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-lg font-semibold">This page failed to load</h1>
      <p className="mt-2 text-sm text-muted-foreground">{error.message || "An unexpected error occurred."}</p>
      {error.digest && <p className="mt-1 font-mono text-[11px] text-muted-foreground">Reference: {error.digest}</p>}
      <Button className="mt-5" variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
