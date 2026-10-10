"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, Pause, Play, Power } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type { AgentStatus } from "@/lib/domain/agent-status";
import { controlAgent } from "./actions";

type Action = "pause" | "resume" | "disable" | "enable";

const COPY: Record<Action, { title: string; body: string; label: string }> = {
  pause: {
    title: "Pause this agent?",
    body: "It finishes the step it is on, then picks up no new work until resumed. Its tasks wait in the queue.",
    label: "Pause",
  },
  resume: { title: "Resume this agent?", body: "Waiting tasks are picked up straight away.", label: "Resume" },
  disable: { title: "Disable this agent?", body: "Workflows that need this agent will wait until it is enabled again.", label: "Disable" },
  enable: { title: "Enable this agent?", body: "The agent becomes available for work again.", label: "Enable" },
};

/** Operator controls. Every action asks for confirmation and is audited server-side. */
export function AgentControls({ agentId, status }: { agentId: string; status: AgentStatus }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState("");
  const actions: Action[] = status === "PAUSED" ? ["resume", "disable"] : status === "DISABLED" ? ["enable"] : ["pause", "disable"];
  const icons = { pause: Pause, resume: Play, disable: Ban, enable: Power };

  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((a) => {
        const Icon = icons[a];
        return (
          <AlertDialog key={a}>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant={a === "disable" ? "destructive" : "outline"} disabled={pending}>
                <Icon /> {COPY[a].label}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{COPY[a].title}</AlertDialogTitle>
                <AlertDialogDescription>{COPY[a].body}</AlertDialogDescription>
              </AlertDialogHeader>
              <div className="grid gap-1.5">
                <Label htmlFor={`reason-${a}`}>Reason (recorded in the audit log)</Label>
                <Input id={`reason-${a}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <Button
                  variant={a === "disable" ? "destructive" : "default"}
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const r = await controlAgent({ agentId, action: a, reason });
                      if (r.ok) {
                        toast.success(`Agent ${a === "pause" ? "paused" : a === "resume" ? "resumed" : a === "disable" ? "disabled" : "enabled"}`);
                        setReason("");
                        router.refresh();
                      } else toast.error(r.error);
                    })
                  }
                >
                  {COPY[a].label}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        );
      })}
    </div>
  );
}
