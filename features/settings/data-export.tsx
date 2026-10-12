"use client";

import { useTransition } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { exportOrganisationData } from "./actions";

/** Asks for the export only when the owner presses the button, then hands the file to the browser. */
export function DataExport() {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await exportOrganisationData();
          if (!res.ok || !res.data) {
            toast.error(res.ok ? "Could not prepare the export" : res.error);
            return;
          }
          const url = URL.createObjectURL(new Blob([res.data.json], { type: "application/json" }));
          const link = document.createElement("a");
          link.href = url;
          link.download = res.data.filename;
          document.body.append(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(url);
          toast.success("Your export has been downloaded");
        })
      }
    >
      <Download className="size-3.5" aria-hidden /> {pending ? "Preparing…" : "Download organisation data"}
    </Button>
  );
}
