import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7", className)} aria-hidden>
      <defs>
        <linearGradient id="tos-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="oklch(0.82 0.12 210)" />
          <stop offset="1" stopColor="oklch(0.62 0.17 280)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#tos-g)" opacity="0.18" />
      <rect x="1.5" y="1.5" width="29" height="29" rx="7.5" fill="none" stroke="url(#tos-g)" strokeOpacity="0.6" />
      <path d="M9 10h14M16 10v13" stroke="url(#tos-g)" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="22.5" cy="21.5" r="2.2" fill="oklch(0.82 0.12 210)" />
    </svg>
  );
}
