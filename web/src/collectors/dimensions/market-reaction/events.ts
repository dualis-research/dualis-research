import { and, eq, gte } from "drizzle-orm";
import type { DriverEventKind, GoldDriverEvent } from "@/db/schema/analysis";
import { documents } from "@/db/schema/documents";
import * as gold from "@/db/schema/gold";
import { goldNewsItems, goldNewsLinks } from "@/db/schema/news";
import type { Db } from "@/db/types";
import { moveOf, windowOf, type MoveWindow, type PriceMove } from "./moves";
import { HISTORY_YEARS } from "@/collectors/history";

/** The analysis reads 10 years of events (docs/architecture.md, common objects; `HISTORY_YEARS`). */
export const EVENT_YEARS = HISTORY_YEARS;
const DAY = 86_400_000;

/** A dated event before any price is put on it. */
export type RawEvent = { kind: DriverEventKind; sourceId: string; day: string; title: string; url: string | null };

/**
 * The events (common objects): every results release (gold.documents), news item (gold.news_links) and
 * other filing (gold.filings not already a release) of the last `EVENT_YEARS`, oldest first. Data only, no judgment.
 */
export async function rawEventsOf(db: Db, symbol: string, now = new Date()): Promise<RawEvent[]> {
  const since = new Date(now.getTime() - EVENT_YEARS * 365.25 * DAY);
  const [docs, news, filed] = await Promise.all([
    db.select({ id: documents.id, title: documents.title, filedAt: documents.filedAt }).from(documents).where(and(eq(documents.symbol, symbol), gte(documents.filedAt, since))),
    db
      .select({ id: goldNewsItems.id, title: goldNewsItems.title, url: goldNewsItems.url, publishedAt: goldNewsItems.publishedAt, firstSeenAt: goldNewsItems.firstSeenAt })
      .from(goldNewsLinks)
      .innerJoin(goldNewsItems, eq(goldNewsItems.id, goldNewsLinks.newsItemId))
      .where(and(eq(goldNewsLinks.symbol, symbol), gte(goldNewsLinks.firstSeenAt, since))),
    db.select({ id: gold.filings.id, form: gold.filings.form, title: gold.filings.title, filedAt: gold.filings.filedAt, url: gold.filings.url }).from(gold.filings).where(and(eq(gold.filings.symbol, symbol), gte(gold.filings.filedAt, since))),
  ]);
  const releases = new Set(docs.map((d) => d.id));
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return [
    ...docs.map((d) => ({ kind: "release" as const, sourceId: d.id, day: day(d.filedAt), title: d.title, url: null })),
    ...news.map((n) => ({ kind: "news" as const, sourceId: String(n.id), day: day(n.publishedAt ?? n.firstSeenAt), title: n.title, url: n.url })),
    ...filed.filter((f) => !releases.has(f.id)).map((f) => ({ kind: "filing" as const, sourceId: f.id, day: day(f.filedAt), title: f.form ? `${f.form}: ${f.title}` : f.title, url: f.url })),
  ]
    .filter((e) => e.day >= day(since))
    .sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind) || a.sourceId.localeCompare(b.sourceId));
}

/** Each event with its OWN 5 trading days (the step-2 window starting on or after its day) and the move it sits in. */
export function pricedEvents(symbol: string, raw: RawEvent[], windows: MoveWindow[], moves: PriceMove[], bench: string): Omit<GoldDriverEvent, "rebuiltAt">[] {
  const seen = new Set<string>();
  return raw.flatMap((e) => {
    const id = `${symbol}|${e.kind}:${e.sourceId}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const w = windowOf(windows, e.day);
    return [{ id, symbol, kind: e.kind, sourceId: e.sourceId, day: e.day, title: e.title, url: e.url, stock: w?.stock ?? null, benchReturn: w?.bench ?? null, beta: w?.beta ?? null, reaction: w?.reaction ?? null, z: w?.z ?? null, bench, moveId: moveOf(moves, w) }];
  });
}
