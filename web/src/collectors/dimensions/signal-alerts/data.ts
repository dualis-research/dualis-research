import { asc, eq } from "drizzle-orm";
import { type ExhibitPoint, type ExhibitSeries, kpiDrivers, narratives, type ThesisSide } from "@/db/schema/analysis";
import { reversalHeadline, reversalTag } from "@/content/reversal-words";
import { companyProfiles } from "@/db/schema/gold";
import type { Db } from "@/db/types";
import { sideOfSignal, type SignalStep } from "@/content/signal-alert";
import type { Complete } from "@/llm/complete";
import { storyBreak } from "../content-visuals/story-break";

/**
 * What the alert shows, read from gold when the alert is planned (it lands in bronze as the plan's payload): the signal,
 * the story the market holds, the reported figure that breaks it (the strongest Price Driver turning against it now,
 * with its own series chart and the two periods it compares), and each trusted Price Driver (its name, what the market
 * believes about it) with its reversal. Never the fair value, the quote vs it or a
 * gap (Thierry 2026-11-16: not confident in our fair values; real figures + the shortest convincing why of the break).
 */
export type AlertInput = SignalStep & {
  symbol: string;
  name: string | null;
  side: ThesisSide;
  /** The story the market holds on the signal's thesis (one sentence). */
  narrative: string | null;
  /** The reported figure that breaks the story: the judge's reality line + the Exhibit it reads, latest vs `base`. */
  breaks: {
    driver: string;
    tag: string;
    headline: string | null;
    chart: { title: string; chart: "bar" | "line"; series: ExhibitSeries[]; points: ExhibitPoint[]; sources: string[] };
    base: string | null;
  }[];
  /** The trusted Price Drivers: name, the narrative's belief about it, its reversal. */
  drivers: {
    title: string;
    summary: string | null;
    state: { effect: string; strength: string; headline: string | null; since: string | null; pricedIn: string | null } | null;
  }[];
};

/** Panels of the alert: the strongest reversing driver's figure first (one picture stays short on a phone). */
export const ALERT_BREAKS = 1;

export async function alertInput(db: Db, c: SignalStep & { symbol: string }, complete?: Complete): Promise<AlertInput> {
  const side = sideOfSignal(c.toSignal);
  const [[profile], [story], pds, broken] = await Promise.all([
    db.select({ name: companyProfiles.name }).from(companyProfiles).where(eq(companyProfiles.symbol, c.symbol)),
    db.select({ text: narratives.text }).from(narratives).where(eq(narratives.id, `${c.symbol}:${side}`)),
    db.select().from(kpiDrivers).where(eq(kpiDrivers.symbol, c.symbol)).orderBy(asc(kpiDrivers.rank)),
    storyBreak(db, c.symbol, complete, side),
  ]);
  const rows = pds
    .filter((k) => k.level === "strong" || k.level === "weak")
    .map((k) => {
      const r = k.reversal;
      return { title: k.name, summary: k.marketBelief, state: r ? { ...reversalTag(r), headline: reversalHeadline(r), since: null, pricedIn: r.pricedIn ?? null } : null };
    });
  // The drivers turning against the story first (strong before weak), the others after, each group by rank.
  const turn = (r: (typeof rows)[number]) => (r.state?.effect === "reversal" ? (r.state.strength === "strong" ? "2" : "1") : "0");
  return {
    symbol: c.symbol,
    fromSignal: c.fromSignal,
    fromStrength: c.fromStrength,
    toSignal: c.toSignal,
    toStrength: c.toStrength,
    name: profile?.name ?? null,
    side,
    narrative: story?.text ?? null,
    breaks: (broken?.drivers ?? []).slice(0, ALERT_BREAKS).map((d) => ({
      driver: d.title,
      tag: d.tag,
      headline: d.headline,
      chart: { title: d.exhibit.title, chart: d.exhibit.chart, series: d.exhibit.series, points: d.exhibit.points, sources: d.exhibit.sources },
      base: d.base,
    })),
    drivers: [...rows].sort((a, b) => turn(b).localeCompare(turn(a))),
  };
}
