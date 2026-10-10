"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { archiveDocument, verifyDocument } from "./actions";

export function DocumentActions({ id, verified }: { id: string; verified: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) =>
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error ?? "Something went wrong");
      else {
        toast.success(done);
        router.refresh();
      }
    });
  return (
    <div className="flex gap-1.5">
      {!verified && (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => verifyDocument(id), "Document verified")}>
          Verify
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          if (confirm("Remove this document? The agents will stop using it. It stays in the audit trail.")) run(() => archiveDocument(id), "Document removed");
        }}
      >
        Remove
      </Button>
    </div>
  );
}
