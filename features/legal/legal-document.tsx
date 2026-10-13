import { DRAFT_NOTICE, type LegalSection } from "@/lib/legal/content";
import { LEGAL_TITLES, LEGAL_VERSIONS, type LegalKind } from "@/lib/legal/versions";

const slug = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** A legal document as a readable page. While the text is a draft, the notice says so before anything else. */
export function LegalDocument({ kind, sections }: { kind: LegalKind; sections: LegalSection[] }) {
  return (
    <article className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{LEGAL_TITLES[kind]}</h1>
        <p className="text-xs text-muted-foreground">Version {LEGAL_VERSIONS[kind]}</p>
      </header>
      <aside role="note" aria-label="Draft notice" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
        {DRAFT_NOTICE}
      </aside>
      {sections.map((section) => (
        <section key={section.heading} aria-labelledby={`h-${slug(section.heading)}`} className="grid gap-2">
          <h2 id={`h-${slug(section.heading)}`} className="text-sm font-semibold">
            {section.heading}
          </h2>
          {section.body.map((paragraph) => (
            <p key={paragraph} className="text-sm leading-relaxed text-muted-foreground">
              {paragraph}
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}
