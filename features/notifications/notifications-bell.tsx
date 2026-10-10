"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useLiveRows, useTableChanges } from "@/features/realtime/hooks";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Database } from "@/types/database";
import { markNotificationsRead } from "./actions";

type Notification = Database["public"]["Tables"]["notifications"]["Row"];

export function NotificationsBell({ initial }: { initial: Notification[] }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const rows = useLiveRows<Notification>("notifications", initial, {
    filter: (n) => n.read_at === null,
    sort: (a, b) => b.created_at.localeCompare(a.created_at),
    limit: 20,
  });

  useTableChanges("notifications", (p) => {
    if (p.eventType !== "INSERT") return;
    const n = p.new as unknown as Notification;
    const show = n.severity === "ERROR" || n.severity === "CRITICAL" ? toast.error : n.severity === "WARNING" ? toast.warning : toast.info;
    show(n.title, { description: n.body ?? undefined });
  });

  const markAll = () =>
    start(async () => {
      const res = await markNotificationsRead(rows.map((r) => r.id));
      if (!res.ok) toast.error(res.error);
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Notifications, ${rows.length} unread`}>
          <Bell />
          {rows.length > 0 && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-violet-400" aria-hidden />}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Notifications</DialogTitle>
        </DialogHeader>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">You are all caught up.</p>
        ) : (
          <ul className="grid gap-2">
            {rows.map((n) => (
              <li key={n.id} className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-2">
                  <p
                    className={cn(
                      "text-sm font-medium",
                      (n.severity === "ERROR" || n.severity === "CRITICAL") && "text-red-300",
                      n.severity === "WARNING" && "text-amber-300",
                    )}
                  >
                    {n.title}
                  </p>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(n.created_at)}</span>
                </div>
                {n.body && <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{n.body}</p>}
                {n.link && (
                  <Link href={n.link} onClick={() => setOpen(false)} className="mt-1 inline-block text-xs text-primary hover:underline">
                    Open
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
        {rows.length > 0 && (
          <Button variant="outline" size="sm" onClick={markAll} disabled={pending}>
            Mark all as read
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
