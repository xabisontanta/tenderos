import Link from "next/link";
import { Logo } from "@/components/command-centre/logo";
import { LEGAL_PATHS, LEGAL_TITLES } from "@/lib/legal/versions";

/** Public pages for the terms and privacy notice: reachable before anyone has an account. */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-8 px-4 py-8">
      <header className="flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <Logo className="size-7" />
          <span className="text-sm font-semibold tracking-tight">TenderOS</span>
        </Link>
        <Link href="/login" className="text-xs text-primary hover:underline">
          Sign in
        </Link>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="flex gap-4 border-t pt-4 text-xs text-muted-foreground">
        <Link href={LEGAL_PATHS.terms} className="hover:underline">
          {LEGAL_TITLES.terms}
        </Link>
        <Link href={LEGAL_PATHS.privacy} className="hover:underline">
          {LEGAL_TITLES.privacy}
        </Link>
      </footer>
    </div>
  );
}
