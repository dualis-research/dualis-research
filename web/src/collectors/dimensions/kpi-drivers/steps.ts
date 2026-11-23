import type { DocCitation, GoldDriverEvent, GoldPriceMove, KpiEventRow, KpiMeasure, KpiPeriod, KpiResult } from "@/db/schema/analysis";
import type { StoredSeries } from "../analysis/series";

/**
 * Steps 4 and 5 of the KPI drivers (DRIVERS-SIX-STEPS-1123): pure code over stored rows, the console may import it.
 * 4) When the KPI moved: its value per period at the finest period it is reported (half years for a Hong Kong company),
 *    each period's change on the same period a year earlier, and how many times its usual change that is (the median
 *    of the series' other changes); >= 2 = significant.
 * 5) Event by event: each step-1 event crossed with the KPI's moves and the step-2 price moves; confirms / invalidates /
 *    other cause / nothing by rule, no judgment.
 */

/** A period change at least this many times the usual one is significant. */
export const KPI_RATIO = 2;
/** A release reports the latest period that ended at most this long before it (an annual report ~100 days after the year end). */
export const REPORTED_WITHIN_DAYS = 140;
const DAY = 86_400_000;

type PeriodType = KpiPeriod["periodType"];
const FINEST: PeriodType[] = ["quarter", "half", "year"];
const PREFIX: Record<PeriodType, string> = { quarter: "q", half: "h", year: "" };
const GRAIN: Record<PeriodType, string> = { quarter: "quarters", half: "half years", year: "years" };
const bare = (label: string) => label.replace(/ \((half-yearly|quarterly)\)$/, "");

/** The series a key names at one period type: `metric:x` at half = `hmetric:x`; a key already at its grain stays. */
function atGrain(catalog: Map<string, StoredSeries>, key: string, type: PeriodType): StoredSeries | undefined {
  const base = key.replace(/^[qh](line|metric):/, "$1:");
  const s = /^(line|metric):/.test(base) ? catalog.get(`${PREFIX[type]}${base}`) : catalog.get(key);
  return s && s.periodType === type ? s : undefined;
}

/** Terms of a formula of stored keys: `a / b`, `a / b * 365`, `a - b` (operators between spaces, left to right). */
export function parseFormula(formula: string, catalog: Map<string, StoredSeries>): { terms: (string | number)[]; ops: string[] } | null {
  const parts = formula.trim().split(/\s+([/*+-])\s+/);
  if (parts.length < 3 || parts.length % 2 === 0) return null;
  const terms: (string | number)[] = [];
  const ops: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) ops.push(parts[i]);
    else if (/^-?\d+(\.\d+)?$/.test(parts[i])) terms.push(Number(parts[i]));
    else if (FINEST.some((t) => atGrain(catalog, parts[i], t)) || catalog.has(parts[i])) terms.push(parts[i]);
    else return null;
  }
  return terms.some((t) => typeof t === "string") ? { terms, ops } : null;
}

const apply = (a: number, op: string, b: number) => (op === "/" ? (b === 0 ? NaN : a / b) : op === "*" ? a * b : op === "+" ? a + b : a - b);

/**
 * The KPI's values at the finest period type every key it reads holds at least 2 periods of since `since`: a stored
 * series as is, a formula evaluated period by period. Null when nothing stored measures it (step 4 then reads reports).
 */
export function measureKpi(catalog: Map<string, StoredSeries>, k: { series: string | null; approximation: string | null }, since: string): { measure: KpiMeasure; points: Map<string, number> } | null {
  const recent = (s: StoredSeries) => [...s.points.keys()].filter((p) => p >= since).length >= 2;
  if (k.series) {
    for (const type of FINEST) {
      const s = atGrain(catalog, k.series, type);
      if (s && recent(s)) return { measure: { source: "series", label: `${bare(s.label)}, ${GRAIN[type]}`, periodType: type, unit: s.unit, currency: s.currency, providers: s.sources }, points: s.points };
    }
    return null;
  }
  const f = k.approximation ? parseFormula(k.approximation, catalog) : null;
  if (!f) return null;
  for (const type of FINEST) {
    const series = f.terms.map((t) => (typeof t === "number" ? t : atGrain(catalog, t, type)));
    if (series.some((s) => s === undefined || (typeof s !== "number" && !recent(s)))) continue;
    const stored = series.filter((s): s is StoredSeries => typeof s !== "number");
    const periods = [...stored[0].points.keys()].filter((p) => stored.every((s) => s.points.has(p)));
    const points = new Map<string, number>();
    for (const p of periods) {
      const vals = series.map((s) => (typeof s === "number" ? s : s!.points.get(p)!));
      const v = vals.slice(1).reduce((a, x, i) => apply(a, f.ops[i], x), vals[0]);
      if (Number.isFinite(v)) points.set(p, v);
    }
    if ([...points.keys()].filter((p) => p >= since).length < 2) continue;
    // A ratio of two amounts reads as a share (%); scaled by a constant (days, x365) or a sum of amounts keeps its kind.
    const amounts = stored.every((s) => s.unit === "currency");
    const unit = f.ops.length === 1 && f.ops[0] === "/" && amounts ? "ratio" : f.ops.every((o) => o === "+" || o === "-") ? stored[0].unit : "multiple";
    const label = f.terms.map((t, i) => `${i ? ` ${f.ops[i - 1]} ` : ""}${typeof t === "number" ? t : series[i] && typeof series[i] !== "number" ? bare((series[i] as StoredSeries).label) : t}`).join("");
    return { measure: { source: "formula", label: `${label}, ${GRAIN[type]}`, periodType: type, unit, currency: unit === "currency" ? stored[0].currency : null, providers: [...new Set(stored.flatMap((s) => s.sources))].sort() }, points };
  }
  return null;
}

const ym = (p: string) => p.slice(0, 7);
const yearBefore = (p: string) => `${Number(p.slice(0, 4)) - 1}${p.slice(4, 7)}`;
const endOf = (p: string) => Date.parse(`${ym(p)}-28T00:00:00Z`);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Step 4: every period's change on the same period a year earlier and how unusual it is (|change| over the median of
 * the series' OTHER changes; null with fewer than 2 others), each tied to the release that first reported it.
 */
export function kpiPeriods(points: Map<string, number>, measure: KpiMeasure, releases: { id: string; day: string }[], since: string, cites: Map<string, DocCitation> = new Map()): KpiPeriod[] {
  const changeKind = measure.unit === "ratio" ? ("points" as const) : ("relative" as const);
  const byYm = new Map([...points].map(([p, v]) => [ym(p), { p, v }]));
  const changeOf = (p: string): number | null => {
    const prior = byYm.get(yearBefore(p))?.v;
    const v = points.get(p)!;
    if (prior === undefined) return null;
    if (changeKind === "points") return v - prior;
    return prior === 0 ? null : (v - prior) / Math.abs(prior);
  };
  const all = [...points.keys()].sort();
  const changes = new Map(all.map((p) => [p, changeOf(p)]));
  const sorted = [...releases].sort((a, b) => a.day.localeCompare(b.day));
  return all
    .filter((p) => p >= since)
    .map((p) => {
      const change = changes.get(p) ?? null;
      const others = all.filter((q) => q !== p).map((q) => changes.get(q)).filter((c): c is number => c !== null && c !== undefined).map(Math.abs);
      const usual = others.length >= 2 ? median(others) : null;
      const ratio = change !== null && usual !== null && usual > 0 ? Math.abs(change) / usual : null;
      const release = sorted.find((r) => Date.parse(`${r.day}T00:00:00Z`) > endOf(p) && Date.parse(`${r.day}T00:00:00Z`) - endOf(p) <= REPORTED_WITHIN_DAYS * DAY) ?? null;
      return {
        period: p,
        periodType: measure.periodType,
        value: points.get(p)!,
        prior: byYm.get(yearBefore(p))?.v ?? null,
        change,
        changeKind,
        ratio,
        significant: ratio !== null && ratio >= KPI_RATIO,
        releaseId: release?.id ?? null,
        releaseDay: release?.day ?? null,
        cite: cites.get(p) ?? null,
      };
    });
}

/**
 * Step 5: one row per event. The KPI is measured at the release that first reported a period (null elsewhere: not a
 * release, or no new period); the price at the event's own 5 trading days (step 1) and the move it sits in (step 2).
 */
export function eventRows(events: GoldDriverEvent[], periods: KpiPeriod[], expected: "up" | "down", moves: Pick<GoldPriceMove, "id" | "direction">[]): KpiEventRow[] {
  const byRelease = new Map(periods.filter((p) => p.releaseId).map((p) => [p.releaseId!, p]));
  const direction = new Map(moves.map((m) => [m.id, m.direction]));
  return events.map((e) => {
    const p = e.kind === "release" ? byRelease.get(`${e.symbol}|release:${e.sourceId}`) : undefined;
    const kpiMoved = p ? (p.ratio === null ? null : p.significant) : null;
    const priceMoved = e.moveId !== null;
    let result: KpiResult = priceMoved ? "other-cause" : "nothing";
    if (kpiMoved && p?.change != null) {
      const kpiUp = p.change > 0;
      const priceUp = direction.get(e.moveId ?? "") === "up";
      result = priceMoved && kpiUp === (expected === "up" ? priceUp : !priceUp) ? "confirms" : "invalidates";
    }
    return {
      eventId: e.id,
      day: e.day,
      kind: e.kind,
      title: e.title,
      sourceId: e.sourceId,
      url: e.url,
      period: p?.period ?? null,
      from: p?.prior ?? null,
      to: p?.value ?? null,
      change: p?.change ?? null,
      ratio: p?.ratio ?? null,
      kpiMoved,
      stock: e.stock,
      reaction: e.reaction,
      z: e.z,
      moveId: e.moveId,
      priceMoved,
      result,
      cite: p?.cite ?? null,
    };
  });
}

/** How a KPI value reads in a prompt or a row: 8.0% for a ratio, 1.2x for a multiple, 345.6M HKD for an amount. */
export function kpiValue(v: number | null, m: Pick<KpiMeasure, "unit" | "currency">): string {
  if (v === null) return "–";
  if (m.unit === "ratio") return `${(v * 100).toFixed(1)}%`;
  if (m.unit === "multiple") return `${v.toFixed(1)}x`;
  if (m.unit === "per-share") return `${v.toFixed(3)}${m.currency ? ` ${m.currency}` : ""}`;
  const a = Math.abs(v);
  const s = a >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0);
  return `${s}${m.currency ? ` ${m.currency}` : ""}`;
}

/** A KPI change: « -4.0 pts » for a ratio, « +12.3% » for an amount. */
export function kpiChange(change: number | null, kind: KpiPeriod["changeKind"]): string {
  if (change === null) return "–";
  const sign = change >= 0 ? "+" : "-";
  return kind === "points" ? `${sign}${Math.abs(change * 100).toFixed(1)} pts` : `${sign}${Math.abs(change * 100).toFixed(1)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** « 6 months to Mar-25 »: the stretch of time a period covers. */
export const periodWords = (type: string, end: string) =>
  `${type === "year" ? "12 months" : type === "half" ? "6 months" : type === "quarter" ? "3 months" : "Month"} to ${MONTHS[Number(end.slice(5, 7)) - 1]}-${end.slice(2, 4)}`;
