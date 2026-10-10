import * as React from "react";
import { cn } from "@/lib/utils";

/** Accessible native select styled to match inputs. */
export const NativeSelect = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn("flex h-9 w-full rounded-md border border-input bg-card px-2 text-sm disabled:opacity-50 [color-scheme:dark]", className)}
    {...props}
  />
));
NativeSelect.displayName = "NativeSelect";
