"use client";

import "./globals.css";

/**
 * Last-resort boundary for failures in the root layout. It replaces the whole
 * document, so it renders its own html and body and avoids anything that
 * needs the app's providers.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="grid min-h-dvh place-items-center bg-background px-4 text-foreground antialiased">
        <main className="w-full max-w-sm text-center">
          <h1 className="text-lg font-semibold tracking-tight">TenderOS is unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">Something went wrong on our side. Your work is safe. Please try again in a moment.</p>
          {error.digest && <p className="mt-3 font-mono text-[11px] text-muted-foreground">Reference: {error.digest}</p>}
          <button
            type="button"
            onClick={reset}
            className="mt-6 inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-accent"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
