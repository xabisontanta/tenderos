"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Briefcase, Building2, FileStack, FolderOpen, Gauge, Hand, Network, Radar, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard", icon: Gauge },
  { href: "/discover", label: "Discover", icon: Radar },
  { href: "/office", label: "Office", icon: Building2 },
  { href: "/operations", label: "Operations", icon: Network },
  { href: "/tenders", label: "Tenders", icon: FileStack },
  { href: "/approvals", label: "Approvals", icon: Hand },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/company", label: "Company", icon: Briefcase },
  { href: "/documents", label: "Documents", icon: FolderOpen },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppNav({ pendingApprovals }: { pendingApprovals: number }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex gap-1 overflow-x-auto md:flex-col">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              active && "bg-accent text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
            <span>{label}</span>
            {href === "/approvals" && pendingApprovals > 0 && (
              <span
                className="ml-auto rounded-full bg-violet-500/20 px-1.5 text-[10px] font-semibold text-violet-300"
                aria-label={`${pendingApprovals} pending`}
              >
                {pendingApprovals}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
