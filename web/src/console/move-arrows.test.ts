import { describe, expect, it } from "vitest";
import { arrowGroups, arrowWords, moveArrows, NO_ITEM_EXPLAINS } from "./move-arrows";

const move = (id: string, startDay: string, endDay: string, direction: "up" | "down") => ({ id, startDay, endDay, direction, abnormal: direction === "up" ? 0.12 : -0.09, bench: "Hang Seng" });

describe("MOVE-ARROWS-1123: each unusual week with its ONE verdict, read from what is stored", () => {
  const moves = [move("m2", "2025-03-03", "2025-03-07", "down"), move("m1", "2024-05-17", "2024-05-23", "up"), move("m3", "2025-08-01", "2025-08-07", "up")];
  const causes = [
    { id: "m1", kind: "fundamental" as const, fact: "Interim results showed services revenue up 9.6%.", cites: [] },
    { id: "m2", kind: "technical" as const, fact: "A placement priced at a discount.", cites: [] },
  ];
  const arrows = moveArrows(moves, causes);

  it("numbers the moves in date order, each with its verdict (macro and technical read as market, no judgment as unknown)", () => {
    expect(arrows.map((a) => [a.n, a.id, a.week])).toEqual([
      [1, "m1", "fundamental"],
      [2, "m2", "market"],
      [3, "m3", "unknown"],
    ]);
  });

  it("says the stored fact; an unknown week says nothing explains it", () => {
    expect(arrowWords(arrows[0])).toBe("Interim results showed services revenue up 9.6%.");
    expect(arrowWords(arrows[2])).toBe(NO_ITEM_EXPLAINS);
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
