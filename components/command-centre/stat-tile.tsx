import Link from "next/link";
import { cn } from "@/lib/utils";

export function StatTile({
  label,
  value,
  hint,
  href,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  tone?: "violet" | "red" | "amber" | "emerald";
}) {
  const body = (
    <div className={cn("h-full rounded-xl border bg-card p-3.5 transition-colors", href && "hover:border-primary/40")}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1.5 text-2xl font-semibold tabular-nums tracking-tight",
          tone === "violet" && "text-violet-300",
          tone === "red" && "text-red-300",
          tone === "amber" && "text-amber-300",
          tone === "emerald" && "text-emerald-300",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}
