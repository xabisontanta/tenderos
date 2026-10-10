import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "TenderOS", template: "%s · TenderOS" },
  description: "Autonomous tender operations command centre",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#0f131b", colorScheme: "dark" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The CSP nonce is per request, so every page must render dynamically for
  // Next.js to stamp it onto its scripts. Reading headers opts out of static
  // prerendering; a statically built page would have its scripts blocked.
  await headers();
  return (
    <html lang="en-ZA" className={`dark ${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="font-sans">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
