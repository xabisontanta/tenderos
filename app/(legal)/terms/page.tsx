import type { Metadata } from "next";
import { LegalDocument } from "@/features/legal/legal-document";
import { TERMS_SECTIONS } from "@/lib/legal/content";

export const metadata: Metadata = { title: "Terms of Service" };

export default function TermsPage() {
  return <LegalDocument kind="terms" sections={TERMS_SECTIONS} />;
}
