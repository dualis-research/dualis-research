import { inArray } from "drizzle-orm";
import { kpiDrivers, type GoldKpiDriver } from "@/db/schema/analysis";
import type { DigestItem, DriverImpact } from "@/db/schema/daily-email";
import type { Db } from "@/db/types";
import { readEventIds, reversalWord } from "@/content/reversal-words";

/**
 * The « Price Drivers » line under an email item (NEWS-KEY-POINTS-1124). The emails are READERS of the analysis
 * (docs/architecture.md, outputs): no judgment of their own. An item shows the Price Drivers whose step D reading
 * (`gold.kpi_drivers.reversal`) read that very event, as a change of the driver or as its leading indicator, each with
 * that reading's bottom line: reversal (« strong inflection », « weak crack ») or continuation, in the console's words.
 * No reading read the item, or it reads as noise = no line.
 */

/** The `gold.driver_events` ids an email item can be (a filing is a release when its document is stored). */
export const eventIdsOf = (i: Pick<DigestItem, "symbol" | "kind" | "itemId">): string[] =>
  i.itemId ? (i.kind === "filing" ? [`${i.symbol}|filing:${i.itemId}`, `${i.symbol}|release:${i.itemId}`] : [`${i.symbol}|news:${i.itemId}`]) : [];

const RANK = { strong: 0, weak: 1 } as const;

/** The Price Drivers whose step D reading read one of these events, reversals first, then the strongest. */
export function impactsOf(eventIds: string[], drivers: Pick<GoldKpiDriver, "name" | "level" | "rank" | "periods" | "rows" | "measure" | "reversal">[]): DriverImpact[] {
  const out: (DriverImpact & { rank: number })[] = [];
  for (const k of drivers) {
    const r = k.reversal;
    if (!r || (k.level !== "strong" && k.level !== "weak") || (r.strength !== "strong" && r.strength !== "weak")) continue;
    if (r.stance !== "against" && r.stance !== "with") continue;
    const read = readEventIds(k);
    if (!eventIds.some((id) => read.has(id))) continue;
    out.push({ name: k.name, confidence: k.level, effect: r.stance === "against" ? "reversal" : "continuation", strength: r.strength, words: reversalWord(r).word.toLowerCase(), rank: k.rank });
  }
  return out
    .sort((a, b) => Number(b.effect === "reversal") - Number(a.effect === "reversal") || RANK[a.strength] - RANK[b.strength] || a.rank - b.rank)
    .map(({ rank: _rank, ...rest }) => rest);
}

/** Each item with the Price Drivers whose step D reading read it; items with none keep `drivers` null. */
export async function withDriverImpacts(db: Db, items: DigestItem[]): Promise<DigestItem[]> {
  const symbols = [...new Set(items.map((i) => i.symbol))];
  const rows = symbols.length ? await db.select().from(kpiDrivers).where(inArray(kpiDrivers.symbol, symbols)) : [];
  return items.map((i) => {
    const impacts = impactsOf(eventIdsOf(i), rows.filter((k) => k.symbol === i.symbol));
    return { ...i, drivers: impacts.length ? impacts : null };
  });
}
