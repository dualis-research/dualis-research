import type { DriverReversal } from "@/db/schema/analysis";

/**
 * Since when step D reads a Price Driver the way it reads it now (Kevin 2026-11-25: « Since <time ago> que ce signal
 * est "strong inflection" selon l'assessment du LLM », to see whether it is fresh or already priced in). Each reading
 * is one stored judgment (`silver.judgments`, kind `kpi-reversal`, verdict `<stance>:<strength>`); a reading is
 * written only when its facts change, so the current state holds since the oldest reading of the unbroken run of
 * readings with the same verdict, newest first.
 */
export type Reading = { verdict: string; at: Date };

export const readingVerdict = (r: Pick<DriverReversal, "stance" | "strength"> | null | undefined): string | null =>
  r && r.stance ? `${r.stance}:${r.strength}` : null;

export function readingSince(readings: readonly Reading[], current: string | null): Date | null {
  if (current === null) return null;
  const newestFirst = [...readings].sort((a, b) => b.at.getTime() - a.at.getTime());
  if (newestFirst[0]?.verdict !== current) return null;
  let since = newestFirst[0].at;
  for (const r of newestFirst) {
    if (r.verdict !== current) break;
    since = r.at;
  }
  return since;
}
