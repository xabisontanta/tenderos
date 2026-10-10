"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { retryTask } from "@/features/tenders/actions";

export function TaskRetryButton({ taskId }: { taskId: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await retryTask(taskId);
          if (r.ok) {
            toast.success("Retry queued");
            router.refresh();
          } else toast.error(r.error);
        })
      }
    >
      <RotateCcw /> Retry
    </Button>
  );
}
