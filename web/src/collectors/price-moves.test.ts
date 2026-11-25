import { describe, expect, it } from "vitest";
import { findMoves, moveOf, moveWindows, MOVE_Z, windowOf } from "./dimensions/market-reaction/moves";

/** `n` trading days from 2025-01-01, one a calendar day (weekends do not matter to the maths). */
function days(n: number): string[] {
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));
}

/** A deterministic wobble: small daily returns of +-1% around zero. */
const wobble = (i: number) => 0.01 * Math.sin(i * 1.7) * Math.cos(i * 0.37);

function series(dates: string[], ret: (i: number) => number): { date: string; close: number }[] {
  let close = 100;
  return dates.map((date, i) => {
    if (i > 0) close *= 1 + ret(i);
    return { date, close };
  });
}

describe("significant price moves: one definition, 5 trading days against the local index", () => {
  const dates = days(300);
  const JUMP = 280;

  it("finds a +15% day against a flat index as one move, the 5-day windows that hold it merged", () => {
    const bench = series(dates, () => 0);
    const stock = series(dates, (i) => (i === JUMP ? 0.15 : wobble(i)));
    const moves = findMoves("TEST", stock, bench, "Hang Seng");
    expect(moves).toHaveLength(1);
    // Every 5-day window holding the jump is significant: from the window starting 4 days before it to the one starting on it.
    expect(moves[0]).toMatchObject({ id: `TEST:${dates[JUMP - 4]}`, startDay: dates[JUMP - 4], lastStart: dates[JUMP], endDay: dates[JUMP + 4], days: 9, direction: "up", bench: "Hang Seng" });
    expect(moves[0].z).toBeGreaterThanOrEqual(MOVE_Z);
    expect(moves[0].abnormal).toBeGreaterThan(0.12);
  });

  it("finds nothing when the stock only follows its market", () => {
    const market = (i: number) => (i === JUMP ? -0.1 : wobble(i));
    expect(findMoves("TEST", series(dates, market), series(dates, market), "Hang Seng")).toHaveLength(0);
  });

  it("ties an event to the move its own 5-day window sits in, never one outside it", () => {
    const bench = series(dates, () => 0);
    const stock = series(dates, (i) => (i === JUMP ? -0.12 : wobble(i)));
    const windows = moveWindows(stock, bench);
    const moves = findMoves("TEST", stock, bench, "Hang Seng", windows);
    expect(moves).toHaveLength(1);
    expect(moves[0].direction).toBe("down");
    expect(moveOf(moves, windowOf(windows, dates[JUMP]))).toBe(moves[0].id);
    expect(moveOf(moves, windowOf(windows, dates[JUMP - 2]))).toBe(moves[0].id);
    expect(moveOf(moves, windowOf(windows, dates[JUMP + 1]))).toBeNull();
    expect(moveOf(moves, windowOf(windows, dates[200]))).toBeNull();
    // The event's own window: the close before its day to the 5th close.
    const w = windowOf(windows, dates[JUMP])!;
    expect(w.first).toBe(dates[JUMP]);
    expect(w.end).toBe(dates[JUMP + 4]);
    expect(Math.abs(w.z!)).toBeGreaterThanOrEqual(MOVE_Z);
  });
});
