import { and, asc, eq, gte } from "drizzle-orm";
import { quoteStamp } from "../intraday-price";
import { fairValueHistory, fairValues, narratives, type GoldNarrative, type ThesisSide } from "@/db/schema/analysis";
import * as gold from "@/db/schema/gold";
import type { Db } from "@/db/types";
import { majorUnit } from "../financials/derive";

/**
 * A ticker has ONE narrative (Kevin 2026-11-24): the analysis writes it on the trusted Price Drivers and decides its
 * side itself, reading the price, the fair value (base, low, high) and its history. No code rule picks the side.
 * The narrative's id keeps the side: `<symbol>:<side>`.
 */

export const thesisId = (symbol: string, side: ThesisSide) => `${symbol}:${side}`;
/** The ticker's narrative as gold holds it (one row), or undefined when the analysis has not written one yet. */
export async function narrativeOf(db: Db, symbol: string): Promise<GoldNarrative | undefined> {
  return (await db.select().from(narratives).where(eq(narratives.symbol, symbol)))[0];
}

type PriceAndFairValue = { price: number; date: string; stamp: string; currency: string | null; fv: { value: number; low: number | null; high: number | null; currency: string | null } };

/**
 * The fair value (base, low, high) and the quote in the same unit, or the reason they cannot be compared. A fair value
 * computed in another currency (CAD statements of a USD listing) is converted by `valuation` into the quote currency
 * (dimension `fx`); a pair with no stored rate is a reason, said by name.
 */
export async function comparablePrice(db: Db, symbol: string): Promise<{ ok: PriceAndFairValue } | { reason: string }> {
  const [[fv], [q]] = await Promise.all([db.select().from(fairValues).where(eq(fairValues.symbol, symbol)), db.select().from(gold.quotes).where(eq(gold.quotes.symbol, symbol))]);
  if (!fv) return { reason: "no fair value yet (the valuation produced none for this ticker)" };
  if (!(fv.value > 0)) return { reason: `fair value ${fv.value} ${fv.currency ?? ""} is not positive`.trim() };
  if (!q) return { reason: "no quote collected for this ticker" };
  const m = majorUnit(q.close, q.currency);
  if (fv.currency && m.currency && fv.currency !== m.currency) return { reason: `fair value in ${fv.currency}, quote in ${m.currency}: no ${fv.currency}/${m.currency} exchange rate stored (dimension fx)` };
  return { ok: { price: m.price, date: q.date, stamp: quoteStamp(q), currency: m.currency ?? fv.currency, fv: { value: fv.value, low: fv.low, high: fv.high, currency: fv.currency } } };
}

/** The fair value (base, low, high) and the quote in the same unit, or null when they cannot be compared (`comparablePrice` says why). */
export async function priceAndFairValue(db: Db, symbol: string): Promise<PriceAndFairValue | null> {
  const p = await comparablePrice(db, symbol);
  return "ok" in p ? p.ok : null;
}

/** How each side reads in the prompts and on screen: its story and what a turn against it is. */
export const SIDE = {
  long: {
    label: "Pessimistic narrative",
    story: "the PESSIMISTIC story the market holds on the company: it prices the business below what it is worth",
    reversal: "the bad reason turns: things get better than the market believes (an inflection, the setup of a BUY)",
    continuation: "the bad reason gets worse: the pessimistic story gets stronger",
    signal: "BUY",
    turn: "inflection",
  },
  short: {
    label: "Optimistic narrative",
    story: "the OPTIMISTIC story the market holds on the company: it prices the business above what it is worth",
    reversal: "the good reason breaks: things get worse than the market believes (a crack, the setup of a SELL)",
    continuation: "the good reason gets better: the optimistic story gets stronger",
    signal: "SELL",
    turn: "crack",
  },
} as const satisfies Record<ThesisSide, { label: string; story: string; reversal: string; continuation: string; signal: "BUY" | "SELL"; turn: "inflection" | "crack" }>;

/** Price and fair value enter a judgment key in 5% buckets (Kevin 2026-11-12): a tick never re-asks, a real move does. */
const STEP = Math.log(1.05);
const bucket = (x: number | null) => (x !== null && x > 0 ? Math.round(Math.log(x) / STEP) : "none");
export function marketKey(m: { price: number; fv: { value: number; low: number | null; high: number | null } } | null): string {
  return m ? `price:${bucket(m.price)} fv:${bucket(m.fv.value)} low:${bucket(m.fv.low)} high:${bucket(m.fv.high)}` : "none";
}

const px = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(2));
/** Where the price sits today vs the fair value and its range, for every judge. */
export function marketLine(m: PriceAndFairValue | null): string {
  if (!m) return "Today: no comparable quote and fair value.";
  const range = m.fv.low !== null && m.fv.high !== null ? ` (range ${px(m.fv.low)} to ${px(m.fv.high)})` : "";
  return `Today (${m.stamp}): price ${px(m.price)} ${m.currency ?? ""}, fair value ${px(m.fv.value)}${range}, the price ${((m.price / m.fv.value - 1) * 100).toFixed(1)}% vs the fair value.`;
}

/** The price path a judge reads: 12 month-end closes, the last 10 closes, the latest price (5-minute when the market is open), and every fair value change, oldest first. */
export async function pathLines(db: Db, symbol: string, now = new Date()): Promise<string> {
  const from = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const [[q], bars] = await Promise.all([
    db.select().from(gold.quotes).where(eq(gold.quotes.symbol, symbol)),
    db.select({ date: gold.priceBars.date, close: gold.priceBars.close }).from(gold.priceBars).where(and(eq(gold.priceBars.symbol, symbol), gte(gold.priceBars.date, from))).orderBy(asc(gold.priceBars.date)),
  ]);
  const p = (v: number) => px(majorUnit(v, q?.currency ?? null).price);
  const months = new Map<string, number>();
  for (const b of bars) months.set(b.date.slice(0, 7), b.close);
  return [
    `Month-end closes: ${[...months].map(([m, c]) => `${m} ${p(c)}`).join("; ") || "none"}`,
    `Last closes: ${bars.slice(-10).map((b) => `${b.date} ${p(b.close)}`).join("; ") || "none"}`,
    q ? `Latest price: ${p(q.close)} (${quoteStamp(q)})` : "Latest price: none",
    await fairValueHistoryLine(db, symbol),
  ].join("\n");
}

/** Every stored fair value of the ticker (base and range), oldest first, one line. */
export async function fairValueHistoryLine(db: Db, symbol: string): Promise<string> {
  const fvs = await db.select().from(fairValueHistory).where(eq(fairValueHistory.symbol, symbol)).orderBy(asc(fairValueHistory.day));
  return `Fair value over time (base, range): ${fvs.map((f) => `${f.day} ${px(f.value)}${f.low !== null && f.high !== null ? ` (${f.low.toFixed(2)} to ${f.high.toFixed(2)})` : ""}`).join("; ") || "only today's"}`;
}
