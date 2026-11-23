"use client";

import { Chart } from "@cloudflare/kumo";
import { BarChart, LineChart } from "echarts/charts";
import { AriaComponent, GridComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

import { FONT, INK } from "./driver-chart";
import { type ExhibitUnit, formatUnit } from "./exhibit-format";
import { FitWidth } from "./fit-width";
import { usePageDark } from "./use-page-dark";
import { COLOR } from "@/design/tokens";

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, MarkLineComponent, MarkAreaComponent, AriaComponent, CanvasRenderer]);

export type KpiPoint = { date: string; period: string; value: number };
export type PricePoint = { date: string; raw: number; clean: number };
/** A tested moment drawn as a numbered vertical line: green when the price followed the KPI, red when it did not. */
export type KpiMarker = { n: number; date: string; end: string; verdict: "confirms" | "invalidates" | "neutral" };

const LEGEND: Record<KpiMarker["verdict"], string> = { confirms: "Price followed the KPI", invalidates: "KPI moved, price did not", neutral: "Price moved, KPI did not" };

/**
 * The proof a KPI drives the stock, before any word (Kevin 2026-11-23: « un visuel convainc mieux que du texte »):
 * the KPI as columns on top, the share price under it, pale as traded and dark once its market's move is taken out,
 * and a numbered line at each tested moment. With `from` / `to` it zooms on one moment (its row in the lists).
 */
export function KpiDriverChart({
  kpi,
  unit,
  currency,
  kpiLabel,
  price,
  indexName,
  markers,
  from,
  to,
  height = 300,
  legend = LEGEND,
}: {
  kpi: KpiPoint[];
  unit: ExhibitUnit;
  currency: string | null;
  kpiLabel: string;
  price: PricePoint[];
  indexName: string;
  markers: KpiMarker[];
  from?: string;
  to?: string;
  height?: number;
  /** What each marker colour means, under the chart (the drivers' steps reuse this chart for the price's weeks). */
  legend?: Record<KpiMarker["verdict"], string>;
}) {
  const dark = usePageDark();
  const ink = dark ? INK.dark : INK.light;
  const tone = { confirms: COLOR.long[dark ? "dark" : "light"], invalidates: COLOR.short[dark ? "dark" : "light"], neutral: ink.muted };
  const inWindow = (d: string) => (!from || d >= from) && (!to || d <= to);
  const p = price.filter((x) => inWindow(x.date));
  const k = kpi.filter((x) => inWindow(x.date));
  const m = markers.filter((x) => inWindow(x.date));
  const text = { fontFamily: FONT, fontSize: 11, color: ink.muted };
  // Moments a few days apart share one line and one label (« 2, 3 »), else their numbers print on top of each other.
  const span = (p.length ? Date.parse(p.at(-1)!.date) - Date.parse(p[0].date) : 0) / 86_400_000;
  const near = Math.max(3, span / 60);
  const groups: { date: string; end: string; ns: number[]; verdicts: Set<KpiMarker["verdict"]> }[] = [];
  for (const x of [...m].sort((a, b) => a.date.localeCompare(b.date))) {
    const g = groups.at(-1);
    if (g && (Date.parse(x.date) - Date.parse(g.date)) / 86_400_000 <= near) {
      g.ns.push(x.n);
      g.verdicts.add(x.verdict);
      if (x.end > g.end) g.end = x.end;
    } else groups.push({ date: x.date, end: x.end, ns: [x.n], verdicts: new Set([x.verdict]) });
  }
  const colour = (v: Set<KpiMarker["verdict"]>) => (v.size > 1 ? ink.muted : tone[[...v][0]]);
  const lines = (grid: 0 | 1) => ({
    symbol: "none",
    silent: true,
    data: groups.map((g) => ({
      xAxis: g.date,
      lineStyle: { color: colour(g.verdicts), type: "solid", width: 1.5 },
      // The numbers print on the price's grid (the last one drawn), never over the KPI columns' own labels (toronto-v10 2026-11-23).
      label: grid === labelGrid ? { show: true, formatter: g.ns.filter((n) => n > 0).join(", "), position: "end", color: colour(g.verdicts), fontFamily: FONT, fontSize: 11, fontWeight: 600 } : { show: false },
    })),
  });
  // The 5 trading days measured after each moment, shaded on the price (Kevin 2026-11-23: « quelle time window »).
  const windows = {
    silent: true,
    data: groups.map((g) => [{ xAxis: g.date, itemStyle: { color: colour(g.verdicts), opacity: 0.14 } }, { xAxis: g.end }]),
  };
  const hasKpi = k.length > 0;
  const labelGrid = hasKpi ? 1 : 0;
  // Each bar says which stretch of time it covers and its value, when there are few enough to read.
  const barLabel = k.length <= 10 ? { show: true, position: "top", fontFamily: FONT, fontSize: 10, color: ink.muted, formatter: (x: { data: [string, number, string] }) => `${formatUnit(x.data[1], unit, currency)}\n${x.data[2]}` } : { show: false };
  const options = {
    animation: false,
    textStyle: { fontFamily: FONT },
    aria: { enabled: true },
    tooltip: { trigger: "axis" },
    grid: hasKpi
      ? [
          { left: 56, right: 12, top: 40, height: "30%" },
          { left: 56, right: 12, top: "54%", bottom: 24 },
        ]
      : [{ left: 56, right: 12, top: 18, bottom: 24 }],
    xAxis: (hasKpi ? [0, 1] : [0]).map((g) => ({
      type: "time",
      gridIndex: g,
      // Numeric bounds on BOTH axes, so a column and a line of the same day sit one above the other.
      min: p[0] ? Date.parse(p[0].date) : undefined,
      max: p.at(-1) ? Date.parse(p.at(-1)!.date) : undefined,
      axisLine: { lineStyle: { color: ink.axis } },
      axisTick: { show: false },
      axisLabel: g === (hasKpi ? 1 : 0) ? text : { show: false },
      splitLine: { show: false },
    })),
    yAxis: [
      ...(hasKpi
        ? [{ type: "value", gridIndex: 0, name: kpiLabel, nameTextStyle: { ...text, align: "left" }, axisLabel: { ...text, formatter: (v: number) => formatUnit(v, unit, currency) }, splitLine: { lineStyle: { color: ink.grid } } }]
        : []),
      { type: "value", gridIndex: hasKpi ? 1 : 0, scale: true, name: "Share price", nameTextStyle: { ...text, align: "left" }, axisLabel: text, splitLine: { lineStyle: { color: ink.grid } } },
    ],
    series: [
      ...(hasKpi
        ? [{ type: "bar", name: kpiLabel, xAxisIndex: 0, yAxisIndex: 0, data: k.map((x) => [x.date, x.value, x.period]), label: barLabel, itemStyle: { color: ink.navy }, barMaxWidth: 14, markLine: lines(0), tooltip: { valueFormatter: (v: number) => formatUnit(v, unit, currency) } }]
        : []),
      { type: "line", name: "Share price", xAxisIndex: hasKpi ? 1 : 0, yAxisIndex: hasKpi ? 1 : 0, data: p.map((x) => [x.date, x.raw]), showSymbol: false, lineStyle: { color: ink.muted, width: 1, opacity: 0.5 }, itemStyle: { color: ink.muted }, ...(hasKpi ? {} : { markLine: lines(0) }) },
      { type: "line", name: `Market taken out (${indexName})`, xAxisIndex: hasKpi ? 1 : 0, yAxisIndex: hasKpi ? 1 : 0, data: p.map((x) => [x.date, x.clean]), showSymbol: false, lineStyle: { color: ink.navy, width: 1.75 }, itemStyle: { color: ink.navy }, markArea: windows, ...(hasKpi ? { markLine: lines(1) } : {}) },
    ],
  };
  // What each colour and line means, under the chart (Kevin 2026-11-23: « rouge vert gris manque légende »).
  const key = (swatch: React.ReactNode, words: string) => (
    <li className="inline-flex items-center gap-1.5">
      {swatch}
      {words}
    </li>
  );
  const bar = (color: string, h = 10, w = 2, opacity = 1) => <span aria-hidden className="inline-block" style={{ background: color, width: w, height: h, opacity }} />;
  return (
    <figure className="flex flex-col gap-2">
      <FitWidth>
        <Chart echarts={echarts} options={options as never} height={height} isDarkMode={dark} />
      </FitWidth>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-kumo-default">
        {m.some((x) => x.verdict === "confirms") && key(bar(tone.confirms), legend.confirms)}
        {m.some((x) => x.verdict === "invalidates") && key(bar(tone.invalidates), legend.invalidates)}
        {m.some((x) => x.verdict === "neutral") && key(bar(tone.neutral), legend.neutral)}
        {groups.some((g) => g.verdicts.size > 1) && key(bar(ink.muted), "Moments days apart, mixed")}
        {m.length > 0 && key(bar(ink.muted, 10, 10, 0.25), "Trading days measured")}
        {key(bar(ink.muted, 2, 14, 0.5), "Share price")}
        {key(bar(ink.navy, 2, 14), `Share price, ${indexName} taken out`)}
      </ul>
    </figure>
  );
}
