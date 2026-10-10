import Link from "next/link";
import { LogOut, OctagonAlert } from "lucide-react";
import { Logo } from "@/components/command-centre/logo";
import { AppNav } from "@/components/command-centre/app-nav";
import { WorkerStatus } from "@/components/command-centre/worker-status";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { RealtimeProvider } from "@/features/realtime/realtime-provider";
import { ConnectionIndicator } from "@/features/realtime/connection-indicator";
import { NotificationsBell } from "@/features/notifications/notifications-bell";
import { signOut } from "@/features/auth/actions";
import { requireContext } from "@/lib/data/context";
import { getPendingApprovals, getUnreadNotifications, getWorkerHealth } from "@/lib/data/queries";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext();
  const [notifications, approvals, worker] = await Promise.all([
    getUnreadNotifications(ctx.userId),
    getPendingApprovals(ctx.organisation.id),
    getWorkerHealth(),
  ]);

  return (
    <RealtimeProvider organisationId={ctx.organisation.id} userId={ctx.userId}>
      <TooltipProvider delayDuration={200}>
        <div className="flex min-h-dvh flex-col md:flex-row">
          <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded focus:bg-card focus:p-2">
            Skip to content
          </a>
          <aside className="flex flex-col gap-4 border-b bg-card/40 p-3 md:sticky md:top-0 md:h-dvh md:w-56 md:shrink-0 md:border-b-0 md:border-r">
            <Link href="/" className="flex items-center gap-2 px-1">
              <Logo />
              <div className="leading-tight">
                <p className="text-sm font-semibold tracking-tight">TenderOS</p>
                <p className="max-w-36 truncate text-[11px] text-muted-foreground">{ctx.organisation.name}</p>
              </div>
            </Link>
            <AppNav pendingApprovals={approvals.length} />
            <div className="mt-auto hidden flex-col gap-2 px-1 md:flex">
              <WorkerStatus initial={worker} />
              <ConnectionIndicator />
            </div>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur">
              {ctx.settings.simulation_mode && <Badge variant="warning">Simulation mode</Badge>}
              {ctx.settings.kill_switch && (
                <Badge variant="danger">
                  <OctagonAlert aria-hidden /> Kill switch engaged
                </Badge>
              )}
              <div className="ml-auto flex items-center gap-1">
                <div className="mr-2 md:hidden">
                  <ConnectionIndicator />
                </div>
                <NotificationsBell initial={notifications} />
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {ctx.fullName ?? ctx.email} · {ctx.role}
                </span>
                <form action={signOut}>
                  <Button variant="ghost" size="icon" type="submit" aria-label="Sign out">
                    <LogOut />
                  </Button>
                </form>
              </div>
            </header>
            <main id="main" className="flex-1 p-4 md:p-6">
              {children}
            </main>
          </div>
        </div>
      </TooltipProvider>
    </RealtimeProvider>
  );
}
