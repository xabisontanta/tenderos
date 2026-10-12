import type { FixtureScore } from "./score";

export interface ReportRow {
  fixtureId: string;
  title: string;
  tags: string[];
  score: FixtureScore | null;
  /** Set when the run itself failed (refusal, invalid output, budget). */
  error: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const money = (n: number) => `$${n.toFixed(4)}`;

/** A plain-text report for a terminal or a CI log. */
export function formatReport(rows: ReportRow[], opts: { model: string; minRecall: number }): string {
  const out: string[] = [];
  out.push(`TenderOS evaluation report (model ${opts.model}, pass needs recall >= ${pct(opts.minRecall)} and no forbidden, unverified or missing-gap findings)`);
  out.push("");
  for (const r of rows) {
    const s = r.score;
    const status = r.error ? "ERROR" : s?.passed ? "PASS " : "FAIL ";
    out.push(`${status} ${r.fixtureId}  ${s ? `recall ${pct(s.recall)}` : ""}  ${money(r.costUsd)}  ${r.inputTokens} in / ${r.outputTokens} out  ${r.ms} ms`);
    if (r.error) out.push(`      error: ${r.error}`);
    if (s) {
      if (s.missed.length) out.push(`      missed: ${s.missed.join(", ")}`);
      if (s.wrongStatus.length) out.push(`      wrong status: ${s.wrongStatus.join("; ")}`);
      if (s.forbiddenViolations.length) out.push(`      forbidden content extracted: ${s.forbiddenViolations.join("; ")}`);
      if (s.missingGaps.length) out.push(`      gaps not reported: ${s.missingGaps.join(", ")}`);
      if (s.unverifiedExtracted) out.push(`      ${s.unverifiedExtracted} extracted requirement(s) have an unverified quote`);
      if (!s.injectionOk) out.push("      instruction-like text was not reported correctly");
    }
  }
  const scored = rows.filter((r) => r.score);
  const passed = rows.filter((r) => r.score?.passed).length;
  const meanRecall = scored.length ? scored.reduce((n, r) => n + (r.score?.recall ?? 0), 0) / scored.length : 0;
  const adversarial = rows.filter((r) => r.tags.some((t) => t.startsWith("adversarial:")));
  const advPassed = adversarial.filter((r) => r.score?.passed).length;
  out.push("");
  out.push(`Passed ${passed} of ${rows.length}; mean recall ${pct(meanRecall)}; adversarial ${advPassed} of ${adversarial.length}`);
  out.push(`Spend ${money(rows.reduce((n, r) => n + r.costUsd, 0))}; ${rows.reduce((n, r) => n + r.inputTokens, 0)} input and ${rows.reduce((n, r) => n + r.outputTokens, 0)} output tokens`);
  return out.join("\n");
}
