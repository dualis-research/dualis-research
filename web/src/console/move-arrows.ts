import type { GoldKpiDriver, GoldPriceMove, GoldPriceMoveCause } from "@/db/schema/analysis";

/**
 * MOVE-ARROWS-1123 (Thierry, meeting 2026-11-23: « a chart with arrows pointing at each thing, telling me: this is
 * what happened here »): one arrow per unusual price move of step 2, numbered in date order, with the few words of
 * what happened. Read from what is stored, never a new AI call: the Price Driver Candidates that changed in the move
 * (`tests.explainedMoveIds`) and the move's cause (`gold.price_move_causes.fact`); « No known cause » when neither.
 */
export type MoveArrow = {
  n: number;
  id: string;
  startDay: string;
  endDay: string;
  direction: "up" | "down";
  /** The move once its market is taken out (ratio). */
  abnormal: number;
  bench: string;
  /** Price Driver Candidates that changed in this move, by name. */
  candidates: string[];
  /** What happened, one sentence, or null when nothing is known. */
  fact: string | null;
};

export const NO_KNOWN_CAUSE = "No known cause";

export function moveArrows(
  moves: Pick<GoldPriceMove, "id" | "startDay" | "endDay" | "direction" | "abnormal" | "bench">[],
  causes: Pick<GoldPriceMoveCause, "id" | "fact">[],
  kpis: Pick<GoldKpiDriver, "name" | "tests">[],
): MoveArrow[] {
  const fact = new Map(causes.map((c) => [c.id, c.fact?.trim() || null]));
  return [...moves]
    .sort((a, b) => a.startDay.localeCompare(b.startDay) || a.id.localeCompare(b.id))
    .map((m, i) => ({
      n: i + 1,
      id: m.id,
      startDay: m.startDay,
      endDay: m.endDay,
      direction: m.direction,
      abnormal: m.abnormal,
      bench: m.bench,
      candidates: kpis.filter((k) => k.tests?.explainedMoveIds.includes(m.id)).map((k) => k.name),
      fact: fact.get(m.id) ?? null,
    }));
}

/** The words beside an arrow's number: the candidates that changed, then what happened; « No known cause » when neither. */
export function arrowWords(a: Pick<MoveArrow, "candidates" | "fact">): string {
  const parts = [a.candidates.length ? `${a.candidates.join(", ")} changed` : null, a.fact].filter((x): x is string => !!x);
  return parts.length ? parts.join(". ") : NO_KNOWN_CAUSE;
}

/**
 * Arrows of the same direction a few days apart share one mark (« 3, 4 »), else their numbers print on top of each
 * other; an up arrow sits above the line and a down one below it, so the two directions never collide.
 */
export function arrowGroups(arrows: MoveArrow[], spanDays: number): { day: string; direction: "up" | "down"; arrows: MoveArrow[] }[] {
  const near = Math.max(5, spanDays / 30);
  const out: { day: string; direction: "up" | "down"; arrows: MoveArrow[] }[] = [];
  for (const dir of ["up", "down"] as const) {
    for (const a of arrows.filter((x) => x.direction === dir)) {
      const g = out.filter((x) => x.direction === dir).at(-1);
      if (g && (Date.parse(a.endDay) - Date.parse(g.day)) / 86_400_000 <= near) g.arrows.push(a);
      else out.push({ day: a.endDay, direction: dir, arrows: [a] });
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}
