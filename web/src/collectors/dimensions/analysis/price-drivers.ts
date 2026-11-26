import { asc, eq } from "drizzle-orm";
import { kpiDrivers, type GoldKpiDriver } from "@/db/schema/analysis";
import type { Db } from "@/db/types";
import { kpiChange, kpiValue, periodWords } from "../kpi-drivers/steps";
import { fnv } from "./facts";

/**
 * The Price Drivers of a ticker (step B: the candidates given a strong or weak confidence), strong first, as the
 * narrative (step C) reads them. The narrative names the ones that explain it; it never invents a reason.
 */

const RANK = { strong: 0, weak: 1, none: 2 } as const;
export const isTrusted = (k: Pick<GoldKpiDriver, "level">) => k.level === "strong" || k.level === "weak";

export async function trustedDrivers(db: Db, symbol: string): Promise<GoldKpiDriver[]> {
  const rows = await db.select().from(kpiDrivers).where(eq(kpiDrivers.symbol, symbol)).orderBy(asc(kpiDrivers.rank));
  return rows.filter(isTrusted).sort((a, b) => RANK[a.level ?? "none"] - RANK[b.level ?? "none"] || a.rank - b.rank);
}

const KIND = { kpi: "a company KPI", policy: "a policy", industry: "an industry fact" } as const;
/** How many periods (a KPI) or changes (a policy, an industry fact) of a driver the narrative reads. */
const SHOWN = 8;

/** One Price Driver in words: what it is, how it is measured, when it changed, its confidence and step B's two tests. */
export function driverLines(k: GoldKpiDriver, label: string): string {
  const t = k.tests;
  const m = k.measure;
  const own = m
    ? k.periods.slice(-SHOWN).map((p) => `    ${periodWords(p.periodType, p.period)}: ${kpiValue(p.value, m)} (${kpiChange(p.change, p.changeKind)} on a year earlier)${p.significant ? `, a change that matters${p.why ? `: ${p.why}` : ""}` : ""}`)
    : k.rows.filter((r) => r.kpiMoved === true).slice(-SHOWN).map((r) => `    ${r.day}: turned ${r.changeUp ? "more favourable" : "less favourable"}${r.kpiWhy ? `, ${r.kpiWhy}` : ""} (${r.title.replace(/\s+/g, " ")})`);
  return [
    `${label} [${KIND[k.kind]}, ${k.level} confidence] ${k.name}. ${k.why} When it goes up, the share price should go ${k.expected}.`,
    m ? `  Measured as: ${m.label}. Its periods, oldest first:` : "  No figure: read in the events. When it changed, oldest first:",
    ...(own.length ? own : ["    none stored"]),
    `  Confidence: ${k.level}. ${k.reason ?? ""}`.trimEnd(),
    t
      ? `  Tests: A) of ${t.changes} significant changes, ${t.followed} were followed by a significant unbiased 1-week move the expected way, ${t.against} were not; B) it changed on the first day of ${t.explained} of the ${t.moves} significant 1-week moves.`
      : "  Tests: not counted.",
  ].join("\n");
}

/** What of a driver enters the analysis hash: its identity, level, measure and changes; never its prose or its reversal. */
const driverKey = (k: GoldKpiDriver) =>
  [k.id, k.name, k.kind, k.level, k.expected, k.measure?.label ?? "", k.periods.map((p) => `${p.period}:${p.value}:${p.significant ? 1 : 0}`).join(","), k.rows.filter((r) => r.kpiMoved === true).map((r) => `${r.eventId}:${r.changeUp ?? ""}`).join(","), JSON.stringify(k.tests ?? null)].join("|");

/** The Price Drivers block of the analysis prompt, the labels the answer cites (`P1`..) and the hash of the facts in it. */
export function priceDriversText(drivers: GoldKpiDriver[]): { text: string; hash: string; labels: Map<string, GoldKpiDriver> } {
  const labels = new Map(drivers.map((k, i) => [`P${i + 1}`, k]));
  return {
    text: ["The Price Drivers of this stock: the fundamental facts the market has been SHOWN to trade it on (each tested on 10 years of events and significant unbiased 1-week moves), strong confidence first:", ...[...labels].map(([l, k]) => driverLines(k, l))].join("\n"),
    hash: fnv(drivers.map(driverKey).join("\n")),
    labels,
  };
}
