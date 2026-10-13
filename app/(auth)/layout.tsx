import Link from "next/link";
import { Logo } from "@/components/command-centre/logo";
import { LEGAL_PATHS } from "@/lib/legal/versions";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,oklch(0.3_0.06_230/0.35),transparent_60%)]" />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo className="size-10" />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">TenderOS</h1>
            <p className="text-xs text-muted-foreground">Tender operations command centre</p>
          </div>
        </div>
        <div className="rounded-xl border bg-card/80 p-6 shadow-2xl backdrop-blur">{children}</div>
        <p className="mt-4 flex justify-center gap-4 text-[11px] text-muted-foreground">
          <Link href={LEGAL_PATHS.terms} className="hover:underline">
            Terms
          </Link>
          <Link href={LEGAL_PATHS.privacy} className="hover:underline">
            Privacy
          </Link>
        </p>
      </div>
    </main>
  );
}
