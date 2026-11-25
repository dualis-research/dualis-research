import { eq } from "drizzle-orm";
import { kpiDrivers, type DriverReversal, type GoldKpiDriver, type ThesisSide } from "@/db/schema/analysis";
import { goldThierryInputs } from "@/db/schema/thierry-inputs";
import type { Db } from "@/db/types";

/** A Price Driver Candidate row as `kpi-drivers` writes it (tests seed it instead of running steps A and B). */
export function priceDriver(symbol: string, rank: number, name: string, over: Partial<GoldKpiDriver> = {}): typeof kpiDrivers.$inferInsert {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    id: `${symbol}:kpi:${slug}`,
    symbol,
    rank,
    name,
    kind: "kpi",
    foundIn: [],
    tests: { changes: 2, followed: 2, against: 0, moves: 3, explained: 1, explainedMoveIds: [] },
    why: `${name} moves this business.`,
    expected: "up",
    series: null,
    approximation: null,
    measure: null,
    periods: [],
    level: "strong",
    reason: `The stock trades on ${name.toLowerCase()}.`,
    rows: [],
    confirmed: 0,
    invalidated: 0,
    signal: null,
    signalWhy: null,
    marketBelief: null,
    reversal: null,
    direction: null,
    asOf: new Date(),
    ...over,
  };
}

export async function seedPriceDrivers(db: Db, rows: (typeof kpiDrivers.$inferInsert)[]): Promise<void> {
  await db.insert(kpiDrivers).values(rows);
}

/** A step D reading as `kpi-reversal` stores it: in reversal against the narrative of `side`, strong, by default. */
export function reversal(side: ThesisSide, over: Partial<DriverReversal> = {}): DriverReversal {
  return {
    intrinsic: { state: side === "long" ? "reversing-up" : "reversing-down", period: null, why: "It broke its trend." },
    leading: { probability: "none", why: "Nothing recent says more.", events: [] },
    strength: "strong",
    direction: side === "long" ? "up" : "down",
    why: "It turns against what the market believes.",
    side,
    stance: "against",
    turn: side === "long" ? "inflection" : "crack",
    headline: "Q3 revenue $46.0M, up from $40.0M a year earlier",
    durability: "structural",
    magnitude: null,
    pricedIn: "none",
    citations: [],
    judgedAt: new Date().toISOString(),
    ...over,
  };
}

/** Every trusted Price Driver of the ticker read as `r` (what `kpi-reversal` would have stored). */
export async function setReversal(db: Db, symbol: string, r: DriverReversal): Promise<void> {
  await db.update(kpiDrivers).set({ reversal: r, signal: r.stance === "against" ? r.strength : "none", signalWhy: r.why, direction: r.direction }).where(eq(kpiDrivers.symbol, symbol));
}

/** One of Thierry's inputs on a ticker, as his Claude pushed it (gold.thierry_inputs): every LLM step A to E reads it, outside its key. */
export async function seedNote(db: Db, symbol: string, text: string, id = `note-${symbol}-${text.length}`): Promise<void> {
  await db.insert(goldThierryInputs).values({ id, kind: "view", scope: "ticker", symbol, company: null, onWatchlist: true, text, fileName: null, saidAt: new Date("2026-11-20T08:00:00Z"), pushedAt: new Date("2026-11-20T08:01:00Z") });
}
