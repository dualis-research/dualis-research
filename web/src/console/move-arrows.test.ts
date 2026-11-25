import { describe, expect, it } from "vitest";
import { arrowGroups, moveArrows } from "./move-arrows";

const move = (id: string, startDay: string, endDay: string, direction: "up" | "down") => ({ id, startDay, endDay, direction, abnormal: direction === "up" ? 0.12 : -0.09, bench: "Hang Seng" });
const event = (id: string, day: string, moveId: string | null) => ({ id, day, kind: "news" as const, title: id, sourceId: id, url: null, moveId });

describe("MOVE-ARROWS-1123: each significant unbiased move with the events of its week, read from what is stored", () => {
  const moves = [move("m2", "2025-03-03", "2025-03-07", "down"), move("m1", "2024-05-17", "2024-05-23", "up"), move("m3", "2025-08-01", "2025-08-07", "up")];
  const arrows = moveArrows(moves, [event("late", "2024-05-18", "m1"), event("early", "2024-05-17", "m1"), event("quiet", "2024-09-01", null), event("industry", "2025-03-03", "m2")]);

  it("numbers the moves in date order, each with its events oldest first; no verdict on a move", () => {
    expect(arrows.map((a) => [a.n, a.id, a.events.map((e) => e.id)])).toEqual([
      [1, "m1", ["early", "late"]],
      [2, "m2", ["industry"]],
      [3, "m3", []],
    ]);
    expect(arrows[0]).not.toHaveProperty("week");
    expect(arrows[0]).not.toHaveProperty("fact");
  });

  it("merges same-direction arrows days apart into one mark, never an up with a down", () => {
    const close = moveArrows([move("a", "2025-01-01", "2025-01-07", "up"), move("b", "2025-01-08", "2025-01-14", "up"), move("c", "2025-01-08", "2025-01-12", "down")], []);
    const g = arrowGroups(close, 3 * 365);
    expect(g.map((x) => [x.direction, x.arrows.map((a) => a.id)])).toEqual([
      ["up", ["a", "b"]],
      ["down", ["c"]],
    ]);
  });
});
