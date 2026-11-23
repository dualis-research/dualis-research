import { weekVerdict, type GoldPriceMove, type GoldPriceMoveCause, type MoveCite, type WeekVerdict } from "@/db/schema/analysis";

/**
 * MOVE-ARROWS-1123 (Thierry, meeting 2026-11-23: « a chart with arrows pointing at each thing, telling me: this is
 * what happened here »): one arrow per unusual week (step 1), numbered in date order, with step 4's ONE verdict on it
 * (fundamental / market / unknown, from `gold.price_move_causes`) and its fact; the events that explain it (step 3) are
 * the cause's cites. Read from what is stored, never a new AI call. No candidate words here (PROOF-STRUCTURE-1123: « Rent
 * changed » beside « the news does not explain it » read as two verdicts on one week).
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
  /** Step 4's verdict on the week. */
  week: WeekVerdict;
  /** What happened, one sentence, or null when no item explains it. */
  fact: string | null;
  /** Step 3: the items the verdict rests on. */
  cites: MoveCite[];
};

export const WEEK_WORD: Record<WeekVerdict, string> = { fundamental: "Fundamental", market: "Market", unknown: "Unknown" };
/** Step 4's verdict on a week as a badge: one verdict per week, the same on every surface. */
export const WEEK_BADGE = { fundamental: "primary", market: "neutral", unknown: "outline" } as const;
export const NO_ITEM_EXPLAINS = "No news or filing explains it";

export function moveArrows(
  moves: Pick<GoldPriceMove, "id" | "startDay" | "endDay" | "direction" | "abnormal" | "bench">[],
  causes: Pick<GoldPriceMoveCause, "id" | "kind" | "fact" | "cites">[],
): MoveArrow[] {
  const cause = new Map(causes.map((c) => [c.id, c]));
  return [...moves]
    .sort((a, b) => a.startDay.localeCompare(b.startDay) || a.id.localeCompare(b.id))
    .map((m, i) => {
      const c = cause.get(m.id);
      const week = weekVerdict(c?.kind);
      return { n: i + 1, id: m.id, startDay: m.startDay, endDay: m.endDay, direction: m.direction, abnormal: m.abnormal, bench: m.bench, week, fact: week === "unknown" ? null : c?.fact?.trim() || null, cites: c?.cites ?? [] };
    });
}

/** The words beside an arrow's verdict: what happened, or that nothing explains it. */
export function arrowWords(a: Pick<MoveArrow, "fact">): string {
  return a.fact ?? NO_ITEM_EXPLAINS;
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
