import { cn } from "@/lib/utils";

/** Read-only structured payload viewer. Values are rendered as text (never HTML). */
export function JsonView({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={cn("max-h-96 overflow-auto rounded-lg border bg-background/60 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground", className)}>
      {JSON.stringify(value ?? null, null, 2)}
    </pre>
  );
}
