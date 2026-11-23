import { describe, expect, it } from "vitest";
import { arrowGroups, arrowWords, moveArrows, NO_KNOWN_CAUSE } from "./move-arrows";

const move = (id: string, startDay: string, endDay: string, direction: "up" | "down") => ({ id, startDay, endDay, direction, abnormal: direction === "up" ? 0.12 : -0.09, bench: "Hang Seng" });

describe("MOVE-ARROWS-1123: what happened at each unusual move, read from what is stored", () => {
  const moves = [move("m2", "2025-03-03", "2025-03-07", "down"), move("m1", "2024-05-17", "2024-05-23", "up"), move("m3", "2025-08-01", "2025-08-07", "up")];
  const causes = [{ id: "m1", fact: "Interim results showed services revenue up 9.6%." }, { id: "m2", fact: null }];
  const kpis = [
    { name: "Services revenue growth", tests: { changes: 2, followed: 1, against: 0, moves: 3, explained: 2, explainedMoveIds: ["m1", "m3"] } },
    { name: "Store count", tests: null },
  ];
  const arrows = moveArrows(moves, causes, kpis);

  it("numbers the moves in date order", () => {
    expect(arrows.map((a) => [a.n, a.id])).toEqual([
      [1, "m1"],
      [2, "m2"],
      [3, "m3"],
    ]);
  });

  it("says the candidate that changed, then the stored cause; no known cause when neither", () => {
    expect(arrowWords(arrows[0])).toBe("Services revenue growth changed. Interim results showed services revenue up 9.6%.");
    expect(arrowWords(arrows[1])).toBe(NO_KNOWN_CAUSE);
    expect(arrowWords(arrows[2])).toBe("Services revenue growth changed");
    expect(arrowWords({ candidates: ["A", "B", "C", "D"], fact: null })).toBe("A, B and 2 more changed");
    expect(arrowWords({ candidates: ["A", "B"], fact: null })).toBe("A and B changed");
  });

  it("merges same-direction arrows days apart into one mark, never an up with a down", () => {
    const close = moveArrows([move("a", "2025-01-01", "2025-01-07", "up"), move("b", "2025-01-08", "2025-01-14", "up"), move("c", "2025-01-08", "2025-01-12", "down")], [], []);
    const g = arrowGroups(close, 3 * 365);
    expect(g.map((x) => [x.direction, x.arrows.map((a) => a.id)])).toEqual([
      ["up", ["a", "b"]],
      ["down", ["c"]],
    ]);
  });
});
