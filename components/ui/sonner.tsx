"use client";
import { useEffect } from "react";
import { Toaster as Sonner, toast, useSonner } from "sonner";
import { isAal2Message } from "@/lib/auth/mfa-errors";

/**
 * An error that says "Verify with your authenticator..." (the organisation requires a second factor and this session has none,
 * from the database's P0403 or from requireAal2) gets a link to the challenge page, which brings the person back to where they are.
 * Every action in the app reports its errors with toast.error, so the link is added here once instead of in each of them. The
 * toast is replaced by id with one that holds a link, so this does not loop (the new title is not a string).
 */
function Aal2Links() {
  const { toasts } = useSonner();
  useEffect(() => {
    for (const t of toasts) {
      if (typeof t.title !== "string" || !isAal2Message(t.title)) continue;
      const here = `${window.location.pathname}${window.location.search}`;
      toast.error(
        <span>
          {t.title}{" "}
          <a className="font-medium underline underline-offset-2" href={`/mfa?next=${encodeURIComponent(here)}`}>
            Verify now
          </a>
        </span>,
        // It carries a link people need time to use, so it stays until closed.
        { id: t.id, duration: Infinity },
      );
    }
  }, [toasts]);
  return null;
}

export function Toaster() {
  return (
    <>
      <Sonner theme="dark" position="bottom-right" richColors closeButton />
      <Aal2Links />
    </>
  );
}
