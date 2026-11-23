"use client";

import { Chart } from "@cloudflare/kumo";
import { BarChart, LineChart } from "echarts/charts";
import { AriaComponent, GridComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

import { FONT, INK } from "./driver-chart";
import { type ExhibitUnit, formatUnit } from "./exhibit-format";
import { FitWidth } from "./fit-width";
import { usePageDark } from "./use-page-dark";
import { COLOR } from "@/design/tokens";

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, MarkLineComponent, AriaComponent, CanvasRenderer]);

export type KpiPoint = { date: string; value: number };
export type PricePoint = { date: string; raw: number; clean: number };
/** A tested moment drawn as a numbered vertical line: green when the price followed the KPI, red when it did not. */
export type KpiMarker = { n: number; date: string; verdict: "confirms" | "invalidates" };

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
}) {
  const dark = usePageDark();
  const ink = dark ? INK.dark : INK.light;
  const tone = { confirms: COLOR.long[dark ? "dark" : "light"], invalidates: COLOR.short[dark ? "dark" : "light"] };
  const inWindow = (d: string) => (!from || d >= from) && (!to || d <= to);
  const p = price.filter((x) => inWindow(x.date));
  const k = kpi.filter((x) => inWindow(x.date));
  const m = markers.filter((x) => inWindow(x.date));
  const text = { fontFamily: FONT, fontSize: 11, color: ink.muted };
  // Moments a few days apart share one line and one label (« 2, 3 »), else their numbers print on top of each other.
  const span = (p.length ? Date.parse(p.at(-1)!.date) - Date.parse(p[0].date) : 0) / 86_400_000;
  const near = Math.max(3, span / 60);
  const groups: { date: string; ns: number[]; verdicts: Set<KpiMarker["verdict"]> }[] = [];
  for (const x of [...m].sort((a, b) => a.date.localeCompare(b.date))) {
    const g = groups.at(-1);
    if (g && (Date.parse(x.date) - Date.parse(g.date)) / 86_400_000 <= near) {
      g.ns.push(x.n);
      g.verdicts.add(x.verdict);
    } else groups.push({ date: x.date, ns: [x.n], verdicts: new Set([x.verdict]) });
  }
  const colour = (v: Set<KpiMarker["verdict"]>) => (v.size > 1 ? ink.muted : tone[[...v][0]]);
  const lines = (grid: 0 | 1) => ({
    symbol: "none",
    silent: true,
    data: groups.map((g) => ({
      xAxis: g.date,
      lineStyle: { color: colour(g.verdicts), type: "solid", width: 1.5 },
      label: grid === 0 ? { show: true, formatter: g.ns.join(", "), position: "end", color: colour(g.verdicts), fontFamily: FONT, fontSize: 11, fontWeight: 600 } : { show: false },
    })),
  });
  const hasKpi = k.length > 0;
  const options = {
    animation: false,
    textStyle: { fontFamily: FONT },
    aria: { enabled: true },
    tooltip: { trigger: "axis" },
    grid: hasKpi
      ? [
          { left: 56, right: 12, top: 18, height: "34%" },
          { left: 56, right: 12, top: "54%", bottom: 24 },
        ]
      : [{ left: 56, right: 12, top: 18, bottom: 24 }],
    xAxis: (hasKpi ? [0, 1] : [0]).map((g) => ({
      type: "time",
      gridIndex: g,
      min: p[0]?.date,
      max: p.at(-1)?.date,
      axisLine: { lineStyle: { color: ink.axis } },
      axisTick: { show: false },
      axisLabel: g === (hasKpi ? 1 : 0) ? text : { show: false },
      splitLine: { show: false },
    })),
    yAxis: [
      ...(hasKpi
        ? [{ type: "value", gridIndex: 0, name: kpiLabel, nameTextStyle: { ...text, align: "left" }, axisLabel: { ...text, formatter: (v: number) => formatUnit(v, unit, currency) }, splitLine: { lineStyle: { color: ink.grid } } }]
        : []),
      { type: "value", gridIndex: hasKpi ? 1 : 0, scale: true, name: `Share price · dark: ${indexName} taken out`, nameTextStyle: { ...text, align: "left" }, axisLabel: text, splitLine: { lineStyle: { color: ink.grid } } },
    ],
    series: [
      ...(hasKpi
        ? [{ type: "bar", name: kpiLabel, xAxisIndex: 0, yAxisIndex: 0, data: k.map((x) => [x.date, x.value]), itemStyle: { color: ink.navy }, barMaxWidth: 14, markLine: lines(0), tooltip: { valueFormatter: (v: number) => formatUnit(v, unit, currency) } }]
        : []),
      { type: "line", name: "Share price", xAxisIndex: hasKpi ? 1 : 0, yAxisIndex: hasKpi ? 1 : 0, data: p.map((x) => [x.date, x.raw]), showSymbol: false, lineStyle: { color: ink.muted, width: 1, opacity: 0.5 }, itemStyle: { color: ink.muted }, ...(hasKpi ? {} : { markLine: lines(0) }) },
      { type: "line", name: `Market taken out (${indexName})`, xAxisIndex: hasKpi ? 1 : 0, yAxisIndex: hasKpi ? 1 : 0, data: p.map((x) => [x.date, x.clean]), showSymbol: false, lineStyle: { color: ink.navy, width: 1.75 }, itemStyle: { color: ink.navy }, ...(hasKpi ? { markLine: lines(1) } : {}) },
    ],
  };
  return (
    <FitWidth>
      <Chart echarts={echarts} options={options as never} height={height} isDarkMode={dark} />
    </FitWidth>
  );
}
