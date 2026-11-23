import type { Bar } from "./compute";

/**
 * When the stock moved (DRIVERS-SIX-STEPS-1123, Kevin 2026-11-23): the ONE definition of a significant price move in
 * the repo, read by the KPI drivers, the move causes, the narrative drivers and the Analysis page alike. Pure code,
 * the console bundle may import it.
 *
 * Event-study convention (MacKinlay 1997, "Event Studies in Economics and Finance", Journal of Economic Literature
 * 35(1); Brown & Warner 1985), on 5 trading days: a window's move = the stock's return from the close before its first
 * day to the close of its 5th day, minus beta x its OWN market's index over the same days (the local index, Hang Seng
 * for a Hong Kong stock; beta = the OLS slope of its daily returns on the index's over the trailing year, clamped to
 * [0, 2], 1 when it cannot be estimated). z = that move over the standard deviation of the stock's own cleaned 5-day
 * moves of the trailing year. |z| >= 2 = at least twice its usual 5-day move: significant. Consecutive significant
 * windows of the same sign are one move (« the week of »), from the first window's first day to the last one's 5th.
 */

/** Trading days a window spans, the trailing window (one year), and the fewest moves needed before a z means anything. */
export const MOVE_DAYS = 5;
export const MOVE_WINDOW_DAYS = 250;
export const MOVE_MIN_DAYS = 60;
/** |z| at or above this = significant. */
export const MOVE_Z = 2;

export type PriceMove = {
  /** `<symbol>:<start date>`. */
  id: string;
  symbol: string;
  /** First trading day of the first significant window, 5th day of the last one. */
  startDay: string;
  endDay: string;
  /** First day of the last significant window: an event whose own window starts in [startDay, lastStart] sits in this move. */
  lastStart: string;
  /** Trading days in the move. */
  days: number;
  /** Close before the move started, close at its end (stored units). */
  closeBefore: number;
  closeEnd: number;
  /** The stock's return over the move, its local index's over the same span, and the move once the market is taken out (ratios). */
  returnPct: number;
  benchReturn: number | null;
  abnormal: number;
  /** The most unusual window of the move: its cleaned 5-day move over the stock's usual one (|z| = « 2.4x its usual move »). */
  z: number;
  beta: number;
  direction: "up" | "down";
  /** The local index's name (« Hang Seng »). */
  bench: string;
};

/** One 5-trading-day window, keyed on its first day (exported for tests and the events). */
export type MoveWindow = {
  /** Index of the window's first day in the stock's bars. */
  i: number;
  first: string;
  end: string;
  /** The stock's return, the index's, beta, the move once the market is taken out, and its z (null with too little history). */
  stock: number;
  bench: number | null;
  beta: number;
  reaction: number;
  z: number | null;
};

/** Last benchmark close on or before each stock day (holidays differ across markets). */
function benchOnOrBefore(bench: Bar[]): (day: string) => number | null {
  return (day: string) => {
    let lo = 0;
    let hi = bench.length - 1;
    let out: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bench[mid].date <= day) {
        out = bench[mid].close;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return out;
  };
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
function sd(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
}

/** OLS slope of y on x; null when x has no variance or too few days. Clamped to [0, 2]: a regression on noisy small caps can swing wildly. */
function betaOf(ys: number[], xs: number[]): number | null {
  if (xs.length < MOVE_MIN_DAYS) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
  }
  if (!(vx > 1e-12)) return null;
  return Math.min(2, Math.max(0, cov / vx));
}

/**
 * Every 5-trading-day window of a stock, oldest first, each against its local index: the window starting on day i runs
 * from the close of day i-1 to the close of day i+4. Bars sorted oldest first, positive closes, one unit per series.
 */
export function moveWindows(bars: Bar[], bench: Bar[]): MoveWindow[] {
  const at = benchOnOrBefore(bench);
  const b = bars.map((x) => at(x.date));
  const ret = bars.map((x, i) => (i > 0 && bars[i - 1].close > 0 ? x.close / bars[i - 1].close - 1 : null));
  const bret = bars.map((_, i) => (i > 0 && b[i] && b[i - 1] ? b[i]! / b[i - 1]! - 1 : null));
  const span = (from: number, to: number) => ({ stock: bars[to].close / bars[from].close - 1, bench: b[to] && b[from] ? b[to]! / b[from]! - 1 : null });
  const out: MoveWindow[] = [];
  for (let i = 1; i + MOVE_DAYS - 1 < bars.length; i++) {
    const ys: number[] = [];
    const xs: number[] = [];
    for (let j = Math.max(1, i - MOVE_WINDOW_DAYS); j < i; j++) {
      if (ret[j] !== null && bret[j] !== null) {
        ys.push(ret[j]!);
        xs.push(bret[j]!);
      }
    }
    const beta = betaOf(ys, xs) ?? 1;
    const clean = (from: number, to: number) => {
      const s = span(from, to);
      return s.stock - beta * (s.bench ?? 0);
    };
    // The stock's usual 5-day move: every window that ENDED before this one starts, over the trailing year.
    const past: number[] = [];
    for (let j = Math.max(1, i - MOVE_WINDOW_DAYS); j + MOVE_DAYS - 1 < i; j++) past.push(clean(j - 1, j + MOVE_DAYS - 1));
    const s = span(i - 1, i + MOVE_DAYS - 1);
    const reaction = s.stock - beta * (s.bench ?? 0);
    const unit = past.length >= MOVE_MIN_DAYS ? sd(past) : 0;
    out.push({ i, first: bars[i].date, end: bars[i + MOVE_DAYS - 1].date, stock: s.stock, bench: s.bench, beta, reaction, z: unit > 0 ? reaction / unit : null });
  }
  return out;
}

/** The window an event on `day` is measured on: the first one starting on or after that day (null when none is complete yet). */
export function windowOf(windows: MoveWindow[], day: string): MoveWindow | null {
  let lo = 0;
  let hi = windows.length - 1;
  let out: MoveWindow | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (windows[mid].first >= day) {
      out = windows[mid];
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return out;
}

const significant = (w: MoveWindow) => w.z !== null && Math.abs(w.z) >= MOVE_Z;

/** The significant moves of a stock, oldest first: consecutive same-sign significant windows merged into one move. */
export function findMoves(symbol: string, bars: Bar[], bench: Bar[], benchName: string, windows = moveWindows(bars, bench)): PriceMove[] {
  const at = benchOnOrBefore(bench);
  const moves: PriceMove[] = [];
  let run: MoveWindow[] = [];
  const close = () => {
    if (run.length === 0) return;
    const first = run[0];
    const last = run[run.length - 1];
    const peak = run.reduce((a, w) => (Math.abs(w.z!) > Math.abs(a.z!) ? w : a));
    const before = bars[first.i - 1];
    const endBar = bars[last.i + MOVE_DAYS - 1];
    const b0 = at(before.date);
    const b1 = at(endBar.date);
    const returnPct = endBar.close / before.close - 1;
    const benchReturn = b0 && b1 ? b1 / b0 - 1 : null;
    moves.push({
      id: `${symbol}:${first.first}`,
      symbol,
      startDay: first.first,
      endDay: last.end,
      lastStart: last.first,
      days: last.i + MOVE_DAYS - first.i,
      closeBefore: before.close,
      closeEnd: endBar.close,
      returnPct,
      benchReturn,
      abnormal: returnPct - first.beta * (benchReturn ?? 0),
      z: peak.z!,
      beta: first.beta,
      direction: peak.reaction >= 0 ? "up" : "down",
      bench: benchName,
    });
    run = [];
  };
  for (const w of windows) {
    const prev = run.at(-1);
    if (significant(w) && prev && w.i === prev.i + 1 && Math.sign(w.reaction) === Math.sign(prev.reaction)) run.push(w);
    else {
      close();
      if (significant(w)) run.push(w);
    }
  }
  close();
  return moves;
}

/** The move an event sits in: its own window starts inside one (so its own 5-day move is significant, same sign), else null. */
export function moveOf(moves: Pick<PriceMove, "id" | "startDay" | "lastStart">[], w: MoveWindow | null): string | null {
  if (!w) return null;
  return moves.find((m) => w.first >= m.startDay && w.first <= m.lastStart)?.id ?? null;
}
