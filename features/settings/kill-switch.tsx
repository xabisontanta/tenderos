"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { OctagonX, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setKillSwitch } from "./actions";

/** Emergency stop for all agent work in the organisation. Needs a reason; audited. */
export function KillSwitch({ engaged, canChange }: { engaged: boolean; canChange: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState("");
  if (!canChange) return null;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={engaged ? "default" : "destructive"} size="sm">
          {engaged ? <Play /> : <OctagonX />} {engaged ? "Release kill switch" : "Engage kill switch"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{engaged ? "Resume agent work?" : "Stop all agent work?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {engaged
              ? "Queued work resumes and new workflows can start."
              : "No agent starts new work and no workflow can be started until you release it. Work already queued waits; nothing is lost."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="ks-reason">Reason (required, recorded in the audit log)</Label>
          <Input id="ks-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant={engaged ? "default" : "destructive"}
            disabled={pending || reason.trim().length < 3}
            onClick={() =>
              start(async () => {
                const r = await setKillSwitch(!engaged, reason);
                if (r.ok) {
                  toast.success(engaged ? "Kill switch released" : "Kill switch engaged");
                  setReason("");
                  router.refresh();
                } else toast.error(r.error);
              })
            }
          >
            Confirm
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
