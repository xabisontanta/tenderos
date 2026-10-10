"use client";

import { useTransition } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { documentDownloadUrl } from "./actions";

/** Fetches a 60-second download link only when the person asks for the file. */
export function DownloadButton({ id, label = "Download", className }: { id: string; label?: string; className?: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await documentDownloadUrl(id);
          if (!res.ok) toast.error(res.error);
          else if (res.data) window.location.assign(res.data);
        })
      }
      className={cn("inline-flex items-center gap-1 text-xs text-sky-300 hover:underline disabled:opacity-60", className)}
    >
      <Download className="size-3.5" aria-hidden /> {pending ? "Preparing…" : label}
    </button>
  );
}
