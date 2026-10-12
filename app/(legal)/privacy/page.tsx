import type { Metadata } from "next";
import { LegalDocument } from "@/features/legal/legal-document";
import { PRIVACY_SECTIONS } from "@/lib/legal/content";

export const metadata: Metadata = { title: "Privacy Notice" };

export default function PrivacyPage() {
  return <LegalDocument kind="privacy" sections={PRIVACY_SECTIONS} />;
}
