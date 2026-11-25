import type { GoldDriverEvent, GoldPriceMove } from "@/db/schema/analysis";

/**
 * MOVE-ARROWS-1123 (Thierry, meeting 2026-11-23: « a chart with arrows pointing at each thing, telling me: this is
 * what happened here »): one arrow per significant unbiased 1-week move, numbered in date order, with the events whose
 * week it was (the ones step A reads). Read from what is stored, never an AI call; no verdict on a move: a significant
 * unbiased move is always valid (docs/architecture.md).
 */
export type MoveEvent = Pick<GoldDriverEvent, "id" | "day" | "kind" | "title" | "sourceId" | "url">;
export type MoveArrow = {
  n: number;
  id: string;
  startDay: string;
  endDay: string;
  direction: "up" | "down";
  /** The move once its market is taken out (ratio). */
  abnormal: number;
  bench: string;
  /** The events whose 1 week after was this move, oldest first. */
  events: MoveEvent[];
};

export const NO_EVENT = "No event stored that week";

export function moveArrows(
  moves: Pick<GoldPriceMove, "id" | "startDay" | "endDay" | "direction" | "abnormal" | "bench">[],
  events: (MoveEvent & Pick<GoldDriverEvent, "moveId">)[] = [],
): MoveArrow[] {
  const byMove = new Map<string, MoveEvent[]>();
  for (const e of events) if (e.moveId) byMove.set(e.moveId, [...(byMove.get(e.moveId) ?? []), { id: e.id, day: e.day, kind: e.kind, title: e.title, sourceId: e.sourceId, url: e.url }]);
  return [...moves]
    .sort((a, b) => a.startDay.localeCompare(b.startDay) || a.id.localeCompare(b.id))
    .map((m, i) => ({ n: i + 1, id: m.id, startDay: m.startDay, endDay: m.endDay, direction: m.direction, abnormal: m.abnormal, bench: m.bench, events: (byMove.get(m.id) ?? []).sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id)) }));
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
