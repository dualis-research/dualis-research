import type { DocCitation, DriverTests, GoldDriverEvent, GoldPriceMove, KpiEventRow, KpiMeasure, KpiPeriod, KpiResult } from "@/db/schema/analysis";
import type { StoredSeries } from "../analysis/series";

/**
 * Step B of the architecture (docs/architecture.md), the code half: pure code over stored rows, the console may import it.
 * When a candidate changed: a KPI's value per period at the finest period it is reported (half years for a Hong Kong
 * company), each period's change on the same period a year earlier (whether it matters is the AI's assessment, index.ts).
 * Event by event: each event crossed with the candidate's changes and the significant unbiased 1-week moves; confirms /
 * invalidates / other cause / nothing, counted, no judgment. A significant unbiased move IS the price moving: no
 * « fundamental or market? » verdict filters it (rejected, Kevin 2026-11-25).
 */

/** A significant unbiased 1-week move, as the tests read it. */
export type JudgedMove = Pick<GoldPriceMove, "id" | "direction">;

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
 * series as is, a formula evaluated period by period. Null when nothing stored measures it (it is then read in the reports).
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

/**
 * The code half of « when a KPI changed »: every period's change on the same period a year earlier and the release that first reported
 * it (the first one within 140 days of the period end). Whether the change matters is the AI's call (`judgeKpiMoves`).
 */
export function kpiPeriods(points: Map<string, number>, measure: KpiMeasure, releases: { id: string; day: string }[], since: string, cites: Map<string, DocCitation> = new Map()): KpiPeriod[] {
  const changeKind = measure.unit === "ratio" ? ("points" as const) : ("relative" as const);
  const byYm = new Map([...points].map(([p, v]) => [ym(p), { p, v }]));
  const sorted = [...releases].sort((a, b) => a.day.localeCompare(b.day));
  return [...points.keys()]
    .sort()
    .filter((p) => p >= since)
    .map((p) => {
      const v = points.get(p)!;
      const prior = byYm.get(yearBefore(p))?.v ?? null;
      const change = prior === null ? null : changeKind === "points" ? v - prior : prior === 0 ? null : (v - prior) / Math.abs(prior);
      const release = sorted.find((r) => Date.parse(`${r.day}T00:00:00Z`) > endOf(p) && Date.parse(`${r.day}T00:00:00Z`) - endOf(p) <= REPORTED_WITHIN_DAYS * DAY) ?? null;
      return { period: p, periodType: measure.periodType, value: v, prior, change, changeKind, significant: false, why: null, releaseId: release?.id ?? null, releaseDay: release?.day ?? null, cite: cites.get(p) ?? null };
    });
}

/** The period's end as a time (for « announced after the period ended »). */
export const periodEnd = endOf;

/**
 * One row per event. The KPI is measured at the event that first disclosed a period (its report, or an
 * announcement before it, as the AI says; null elsewhere); the price at the event's own 5 trading days and the significant move it sits in.
 */
export function eventRows(events: GoldDriverEvent[], periods: KpiPeriod[], expected: "up" | "down", moves: JudgedMove[]): KpiEventRow[] {
  const byRelease = new Map(periods.filter((p) => p.releaseId).map((p) => [p.releaseId!, p]));
  const direction = new Map(moves.map((m) => [m.id, m.direction]));
  return events.map((e) => {
    const p = byRelease.get(e.id);
    const kpiMoved = p ? (p.change === null ? null : p.significant) : null;
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
      kpiWhy: p?.why ?? null,
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

/** A candidate change at one event: up = the candidate stronger / more favourable, and why. */
export type CandidateChange = { up: boolean; why: string | null };

/**
 * The same for a candidate with no figure (a policy, a qualitative industry fact): the events the AI says carry a change
 * of it, crossed with the price exactly like a KPI (confirms / invalidates / other cause / nothing).
 */
export function changeRows(events: GoldDriverEvent[], changes: Map<string, CandidateChange>, expected: "up" | "down", moves: JudgedMove[]): KpiEventRow[] {
  const direction = new Map(moves.map((m) => [m.id, m.direction]));
  return events.map((e) => {
    const c = changes.get(e.id);
    const priceMoved = e.moveId !== null;
    let result: KpiResult = priceMoved ? "other-cause" : "nothing";
    if (c) {
      const priceUp = direction.get(e.moveId ?? "") === "up";
      result = priceMoved && c.up === (expected === "up" ? priceUp : !priceUp) ? "confirms" : "invalidates";
    }
    return { eventId: e.id, day: e.day, kind: e.kind, title: e.title, sourceId: e.sourceId, url: e.url, period: null, from: null, to: null, change: null, kpiWhy: c?.why ?? null, kpiMoved: c ? true : null, stock: e.stock, reaction: e.reaction, z: e.z, moveId: e.moveId, priceMoved, result, cite: null, changeUp: c ? c.up : null };
  });
}

/**
 * Step B's two tests, counted by code from the rows; the confidence is the AI's.
 * A = each significant change of the candidate: was the 1 week after it a significant unbiased move, the expected way?
 * B = each significant unbiased 1-week move: did the candidate change on the first day of that 1-week bar?
 */
export function driverTests(rows: KpiEventRow[], moves: JudgedMove[]): DriverTests {
  const changed = rows.filter((r) => r.kpiMoved === true);
  const ids = new Set(moves.map((m) => m.id));
  const explained = [...new Set(changed.filter((r) => r.moveId !== null && ids.has(r.moveId)).map((r) => r.moveId!))].sort();
  return {
    changes: changed.length,
    followed: changed.filter((r) => r.result === "confirms").length,
    against: changed.filter((r) => r.result === "invalidates").length,
    moves: moves.length,
    explained: explained.length,
    explainedMoveIds: explained,
  };
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
