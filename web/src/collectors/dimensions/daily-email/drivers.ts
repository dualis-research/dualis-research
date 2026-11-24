import { inArray } from "drizzle-orm";
import { kpiDrivers, parseTag } from "@/db/schema/analysis";
import type { DigestItem, DriverImpact } from "@/db/schema/daily-email";
import type { Db } from "@/db/types";
import { tagWord } from "@/content/signal-words";
import { type EvidenceItemRef, evidenceSource, storedVerdicts } from "../evidence";
import type { Source } from "../../types";

/**
 * Price Driver impact (NEWS-KEY-POINTS-1124, Kevin: « si ça impacte des Price Drivers qu'on avait identifiés pour ce
 * ticker (et la force de ces drivers)… en continuation… ou si ça marque une possibilité de reversal »). The question is
 * the `evidence` judge's (each item x each Narrative Driver = one per trusted Price Driver: reversal / continuation x
 * strong / weak, or noise), asked ONCE and stored by it: the emails only read its verdicts, and for a material item
 * still missing one they run the evidence judge's own source on just those items (`evidenceJudge`, same prompt, keys and
 * storage). Filings are judged too. A ticker with no narrative or no trusted Price Driver shows no block.
 */
export const EVIDENCE_JUDGE_SOURCE = "evidence";
/** The evidence dimension's judge, run by the email dimensions on their batch subjects (`<symbol>|batch|...`) only. */
export const evidenceJudge: Source = { ...evidenceSource, name: EVIDENCE_JUDGE_SOURCE, requiredEnv: [], covers: (subject) => subject.split("|")[1] === "batch" };

/** A verdict kind (`news`, `industry`, `filing`) -> the evidence item it is. */
export const evidenceRef = (kind: string, itemId: string): EvidenceItemRef => ({ kind: kind === "filing" ? "filing" : "news", id: itemId });

/** Each item's Price Drivers it bears on (noise left out), reversals first then by the driver's rank; items with none keep `drivers` null. */
export async function withDriverImpacts(db: Db, items: DigestItem[]): Promise<DigestItem[]> {
  const out = items.map((i) => ({ ...i }));
  for (const symbol of [...new Set(items.map((i) => i.symbol))]) {
    const mine = out.filter((i) => i.symbol === symbol);
    const stored = await storedVerdicts(db, symbol, mine.map((i) => evidenceRef(i.kind, itemIdOf(i))));
    if (!stored) continue;
    const kpiIds = stored.drivers.map((d) => d.kpiDriverId).filter((x): x is string => !!x);
    const kpi = new Map((kpiIds.length ? await db.select({ id: kpiDrivers.id, name: kpiDrivers.name, level: kpiDrivers.level }).from(kpiDrivers).where(inArray(kpiDrivers.id, kpiIds)) : []).map((k) => [k.id, k]));
    for (const item of mine) {
      const ref = evidenceRef(item.kind, itemIdOf(item));
      const verdicts = stored.verdicts.get(`${ref.kind}:${ref.id}`) ?? new Map();
      const impacts: (DriverImpact & { rank: number })[] = [];
      for (const d of stored.drivers) {
        const k = d.kpiDriverId ? kpi.get(d.kpiDriverId) : undefined;
        const v = verdicts.get(d.rank);
        if (!k || (k.level !== "strong" && k.level !== "weak") || !v) continue;
        const tag = parseTag(v.tag);
        if (tag.effect === "noise" || tag.strength === "noise" || (tag.effect !== "reversal" && tag.effect !== "continuation")) continue;
        const words = tag.effect === "reversal" ? tagWord(tag.effect, tag.strength, stored.side).toLowerCase() : "continuation";
        impacts.push({ name: k.name, confidence: k.level, effect: tag.effect, strength: tag.strength as "strong" | "weak", words, rank: d.rank });
      }
      impacts.sort((a, b) => Number(b.effect === "reversal") - Number(a.effect === "reversal") || a.rank - b.rank);
      item.drivers = impacts.length ? impacts.map(({ rank: _rank, ...rest }) => rest) : null;
    }
  }
  return out;
}

/** The digest item's stored id (gold.news_items or gold.filings id). */
const itemIdOf = (i: DigestItem) => i.itemId ?? "";
