import { driverEvents, narratives, signalChanges, signals } from "@/db/schema/analysis";
import * as gold from "@/db/schema/gold";
import { goldNewsItems } from "@/db/schema/news";
import type { Db } from "@/db/types";
import { priceDriver, reversal, seedPriceDrivers } from "./price-drivers";

/** The news item every seeded ticker's reversal reads (gold.news_items id, `driver_events.source_id`). */
export const SEED_NEWS_ID = "6f1d1a52-5555-4a3b-9c1d-000000000001";

/**
 * One analysed ticker with the analysis objects content reads (Kevin 2026-11-24, one chain): signal, narrative, a trusted
 * Price Driver with what the market believes about it, its own reported series and its reversal, the news event that
 * reversal reads, a Signal Change.
 */
export async function seedAnalysedTicker(db: Db, symbol = "CCLD", opts: { name?: string; evidenceHeadline?: string } = {}) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const headline = opts.evidenceHeadline ?? `${symbol} signs a new hospital client`;
  const eventId = `${symbol}|news:${SEED_NEWS_ID}`;
  await db.insert(gold.tickers).values({ symbol, market: "US", aliases: [], inPortfolio: false, analysed: true, position: "long" });
  await db.insert(gold.companyProfiles).values({ symbol, name: opts.name ?? `${symbol} Inc.`, provenance: {} });
  await db.insert(signals).values({
    symbol, signal: "BUY", strength: "strong", side: "long", why: "A new client turns the story.", theses: [{ side: "long", signal: "strong", effect: "reversal", strength: "strong", why: "A new client turns the story.", since: today }], fairValue: 6, fairValueMethod: "m", fairValueLabel: "8x EV/EBITDA", currency: "USD",
    quote: 4, quoteDate: today, gapPct: -1 / 3, evidenceIds: [eventId], since: now,
  });
  await db.insert(narratives).values({ id: `${symbol}:long`, symbol, side: "long", text: `The market thinks ${symbol} lost its biggest client.`, detail: "Detail.", version: "v1", asOf: now });
  await db.insert(goldNewsItems).values({ id: SEED_NEWS_ID, title: headline, url: "https://news.example/n1", publisher: "Reuters", firstSeenAt: now, publishedAt: now, sources: ["google-news"], symbols: [symbol], markets: ["US"] }).onConflictDoNothing();
  await db.insert(driverEvents).values({ id: eventId, symbol, kind: "news", sourceId: SEED_NEWS_ID, day: today, title: headline, url: "https://news.example/n1", stock: null, benchReturn: null, beta: null, reaction: null, z: null, bench: "S&P 500", moveId: null });
  const period = (p: string, value: number, change: number | null) => ({ period: p, periodType: "quarter" as const, value, prior: null, change, changeKind: "relative" as const, significant: change !== null && Math.abs(change) > 0.1, why: null, releaseId: null, releaseDay: null, cite: null });
  const pd = priceDriver(symbol, 1, "Client revenue", {
    measure: { source: "series", label: "Client revenue, quarters", periodType: "quarter", unit: "currency", currency: "USD", providers: ["sec"] },
    periods: [period("2025-09", 40e6, null), period("2025-12", 38e6, -0.05), period("2026-03", 39e6, 0.02), period("2026-06", 46e6, 0.15)],
    marketBelief: "The market thinks the lost client is gone for good.",
    reversal: reversal("long", { headline: "Q2 client revenue $46.0M, up 15%", leading: { probability: "high", why: "A new hospital client signed.", events: [{ id: eventId, day: today, kind: "news", title: headline, sourceId: SEED_NEWS_ID, url: "https://news.example/n1" }] } }),
    signal: "strong",
  });
  await seedPriceDrivers(db, [pd]);
  const changeId = crypto.randomUUID();
  await db.insert(signalChanges).values({ id: changeId, symbol, fromSignal: "none", toSignal: "BUY", fromStrength: "noise", toStrength: "strong", at: now, updateNote: "The new client turns the story.", evidenceIds: [eventId] });
  return { changeId, pdId: pd.id, eventId };
}
