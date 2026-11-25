import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { driverEvents, kpiDrivers, narratives, signals, type ExhibitPoint, type ExhibitSeries, type GoldKpiDriver, type ThesisSide } from "@/db/schema/analysis";
import * as content from "@/db/schema/content";
import { companyProfiles, priceBars } from "@/db/schema/gold";
import { goldNewsItems } from "@/db/schema/news";
import type { Db } from "@/db/types";

/**
 * What the visuals of one Idea are drawn from, read from gold when they are made. Reported figures and the share price
 * only: the fair value is never read (Thierry 2026-11-16: not confident in our fair values, none in published pictures).
 */
export type VisualInput = {
  symbol: string;
  companyName: string | null;
  /** The Idea in one sentence: the card's headline. */
  title: string;
  /** Closes of the last 12 months, oldest first. */
  bars: { date: string; close: number }[];
  priceSources: string[];
  /** The first news the Idea cites that has a link: what a capture shows. */
  newsUrl: string | null;
  /** The news items the Idea cites (an event, or one its Price Drivers' reversals read): the chart's headline strip shows the most prestigious one. */
  news: { headline: string; publisher: string; url: string | null; at: Date; why: string | null; citedSentence: string | null }[];
  /** The Price Drivers the Idea rests on (name, what the market believes about it, the narrative's side), and the narrative: what the price says. */
  drivers: { title: string; summary: string | null; side: ThesisSide }[];
  narratives: { side: ThesisSide; text: string }[];
  /** The ticker's current Signal (gold.signals): the picture's colour when its drivers do not say it. */
  signal: "BUY" | "SELL" | null;
  /** How the Idea is told: the chart judge reads it with the title. */
  angle: string;
  /** The own measured series of each Price Driver the Idea rests on (code-built from `gold.kpi_drivers.periods`). */
  exhibits: VisualExhibit[];
};

/** One chart the picture can draw instead of the price: a Price Driver's own measured series. */
export type VisualExhibit = {
  id: string;
  driverTitle: string;
  /** The thesis the driver belongs to: long (its turn = inflection) or short (its turn = crack). */
  side: ThesisSide;
  title: string;
  chart: "bar" | "line";
  series: ExhibitSeries[];
  points: ExhibitPoint[];
  takeaway: string;
  sources: string[];
};

const PRICE_SOURCE_LABEL: Record<string, string> = { yahoo: "Yahoo Finance", nasdaq: "Nasdaq", cnbc: "CNBC", naver: "Naver Finance" };
/** A chart needs this many closes to say anything. */
export const MIN_BARS = 20;

/** How many periods of a Price Driver's series a picture shows. */
export const DRIVER_PERIODS = 8;
const KEY_PREFIX = { year: "kpi", half: "hkpi", quarter: "qkpi" } as const;

/**
 * A Price Driver's ONE chart (Kevin 2026-11-24, one chain): its own measured series, built by code from the periods
 * `kpi-drivers` stored (its last `DRIVER_PERIODS`), never a chart the model specs. Null for a policy or an industry fact
 * (no figure) or fewer than 2 periods. The key's prefix says the period type (`hkpi:` half years, `qkpi:` quarters).
 */
export function driverExhibit(k: Pick<GoldKpiDriver, "id" | "name" | "measure" | "periods" | "reversal">, side: ThesisSide): VisualExhibit | null {
  const m = k.measure;
  const periods = k.periods.slice(-DRIVER_PERIODS);
  if (!m || periods.length < 2) return null;
  const key = `${KEY_PREFIX[m.periodType]}:${k.id}`;
  return {
    id: k.id,
    driverTitle: k.name,
    side,
    title: m.label,
    chart: "bar",
    series: [{ key, label: m.label, unit: m.unit, currency: m.currency, sources: m.providers }],
    points: periods.map((p) => ({ period: p.period, values: { [key]: p.value } })),
    takeaway: k.reversal?.headline ?? m.label,
    sources: m.providers,
  };
}

export async function visualInput(db: Db, idea: content.SilverContentIdea, now = new Date()): Promise<VisualInput> {
  const symbol = idea.symbol ?? idea.sourceRefs.find((r) => r.symbol)?.symbol ?? "";
  const since = new Date(now.getTime() - 365 * 86400_000).toISOString().slice(0, 10);
  const eventIds = idea.sourceRefs.filter((r) => r.kind === "event").map((r) => r.ref.slice("event:".length));
  const citedDrivers = idea.sourceRefs.filter((r) => r.kind === "driver").map((r) => r.ref.slice("driver:".length));
  const [[profile], bars, pds, [sig], storyRows] = await Promise.all([
    db.select({ name: companyProfiles.name }).from(companyProfiles).where(eq(companyProfiles.symbol, symbol)),
    db.select({ date: priceBars.date, close: priceBars.close, sources: priceBars.sources }).from(priceBars).where(and(eq(priceBars.symbol, symbol), gte(priceBars.date, since))).orderBy(asc(priceBars.date)),
    db.select().from(kpiDrivers).where(eq(kpiDrivers.symbol, symbol)).orderBy(asc(kpiDrivers.rank)),
    db.select({ signal: signals.signal }).from(signals).where(eq(signals.symbol, symbol)),
    db.select({ side: narratives.side, text: narratives.text }).from(narratives).where(eq(narratives.symbol, symbol)),
  ]);
  const side: ThesisSide = storyRows[0]?.side ?? "long";
  // The Price Drivers the Idea rests on: the ones it names, then the ones whose reversal reads an event it cites.
  const drivers = pds.filter((k) => citedDrivers.includes(k.id) || (k.reversal?.leading.events ?? []).some((e) => eventIds.includes(e.id)));
  // The news it cites, then the news its drivers' reversals read: the headline strip and the capture.
  const readIds = [...new Set([...eventIds, ...drivers.flatMap((k) => (k.reversal?.leading.events ?? []).map((e) => e.id))])];
  const events = readIds.length ? await db.select().from(driverEvents).where(inArray(driverEvents.id, readIds)) : [];
  const newsIds = events.filter((e) => e.kind === "news").map((e) => e.sourceId);
  const items = newsIds.length ? await db.select({ id: goldNewsItems.id, publisher: goldNewsItems.publisher }).from(goldNewsItems).where(inArray(goldNewsItems.id, newsIds)) : [];
  const ordered = readIds.map((id) => events.find((e) => e.id === id)).filter((e): e is (typeof events)[number] => !!e);
  const publisherOf = (e: (typeof events)[number]) => items.find((i) => String(i.id) === e.sourceId)?.publisher ?? null;
  return {
    symbol,
    companyName: profile?.name ?? null,
    title: idea.title,
    bars: bars.map((b) => ({ date: b.date, close: b.close })),
    priceSources: [...new Set(bars.flatMap((b) => b.sources))].map((s) => PRICE_SOURCE_LABEL[s] ?? s),
    newsUrl: ordered.map((e) => e.url).find((u): u is string => !!u && /^https?:\/\//.test(u)) ?? null,
    news: ordered.flatMap((e) => {
      const publisher = e.kind === "news" ? publisherOf(e) : null;
      return publisher ? [{ headline: e.title.replace(/\s+/g, " "), publisher, url: e.url, at: new Date(`${e.day}T00:00:00Z`), why: null, citedSentence: null }] : [];
    }),
    drivers: drivers.map((k) => ({ title: k.name, summary: k.marketBelief, side })),
    narratives: storyRows.map((n) => ({ side: n.side, text: n.text })),
    signal: sig && sig.signal !== "none" ? sig.signal : null,
    angle: idea.angle,
    exhibits: drivers.map((k) => driverExhibit(k, side)).filter((e): e is VisualExhibit => !!e),
  };
}
