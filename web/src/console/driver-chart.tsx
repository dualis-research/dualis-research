"use client";

import { Chart } from "@cloudflare/kumo";
import { BarChart, LineChart } from "echarts/charts";
import { AriaComponent, GridComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

import { type ExhibitPeriod, type ExhibitUnit, formatExhibitValue, formatUnit, monthYear, periodLabel } from "./exhibit-format";
import { FitWidth } from "./fit-width";
import { nearestIndex, useChartSource } from "./chart-source";
import { itemHref } from "./item-href";
import { sourceItemId } from "./sourced";
import { usePageDark } from "./use-page-dark";
import { COLOR } from "@/design/tokens";

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, MarkLineComponent, AriaComponent, CanvasRenderer]);

/**
 * A driver's data as a sell-side research exhibit (the look of a bank research note or an Excel chart):
 * numbered title, unit line, flat navy columns for reported periods or a thin line for market prices,
 * black baseline, light horizontal gridlines only, value labels on columns. No source line (SOURCES-ONE-CLICK-1123):
 * with a `symbol`, a click on the chart opens the source of the point under the pointer.
 */

export const INK = { light: { navy: COLOR["brand-chart"].light, text: "#1f2328", muted: "#6b7280", grid: "#e3e5e8", axis: "#1f2328" }, dark: { navy: COLOR["brand-chart"].dark, text: "#e6e8eb", muted: "#9aa1ab", grid: "#2b3038", axis: "#c9ced6" } };
export const FONT = "Arial, Helvetica, sans-serif";

export type { ExhibitPeriod };

export function DriverExhibit({
  number,
  title,
  unit,
  period,
  points,
  sources,
  symbol,
}: {
  number: number;
  title: string;
  unit: string | null;
  period: ExhibitPeriod;
  points: { date: string; value: number }[];
  sources: string[];
  /** The ticker whose Analysis page opens a point's source; none = the chart is not clickable. */
  symbol?: string;
}) {
  const dark = usePageDark();
  const ink = dark ? INK.dark : INK.light;
  const bars = period !== "market";
  const fmt = (v: number) => formatExhibitValue(v, unit);
  const hasNegative = points.some((p) => p.value < 0);
  const text = { fontFamily: FONT, fontSize: 11, color: ink.muted };
  const times = points.map((p) => Date.parse(`${p.date}T00:00:00Z`));
  const source = useChartSource(
    symbol
      ? (x) => {
          const p = points[bars ? Math.round(x) : nearestIndex(times, x)];
          return p ? itemHref(symbol, sourceItemId({ l: title, v: fmt(p.value), d: periodLabel(p.date, period), s: sources })) : null;
        }
      : null,
  );

  const options = {
    animation: false,
    textStyle: { fontFamily: FONT },
    grid: { left: 0, right: 16, top: 22, bottom: 4, containLabel: true },
    tooltip: {
      confine: true,
      trigger: "axis",
      axisPointer: { type: bars ? "shadow" : "line", lineStyle: { color: ink.muted, width: 1 }, shadowStyle: { color: "rgba(127,127,127,0.08)" } },
      backgroundColor: dark ? "#16191d" : "#ffffff",
      borderColor: ink.grid,
      borderWidth: 1,
      textStyle: { fontFamily: FONT, fontSize: 12, color: ink.text },
      valueFormatter: (v: number) => fmt(v),
    },
    xAxis: bars
      ? {
          type: "category",
          data: points.map((p) => periodLabel(p.date, period)),
          axisLine: { show: true, onZero: true, lineStyle: { color: ink.axis, width: 1 } },
          axisTick: { show: false },
          axisLabel: { ...text, color: ink.text, margin: 10 },
        }
      : {
          type: "time",
          axisLine: { show: true, onZero: false, lineStyle: { color: ink.axis, width: 1 } },
          axisTick: { show: true, lineStyle: { color: ink.axis } },
          axisLabel: { ...text, color: ink.text, hideOverlap: true, formatter: (t: number) => monthYear(new Date(t).toISOString().slice(0, 10)) },
          splitNumber: 5,
          splitLine: { show: false },
        },
    yAxis: {
      type: "value",
      scale: !bars,
      axisLine: { show: false },
      axisTick: { show: false },
      splitNumber: 4,
      splitLine: { lineStyle: { color: ink.grid, width: 1 } },
      axisLabel: { ...text, formatter: (v: number) => fmt(v) },
    },
    series: [
      bars
        ? {
            type: "bar",
            data: points.map((p) => p.value),
            barMaxWidth: 36,
            barCategoryGap: "35%",
            itemStyle: { color: ink.navy, borderRadius: 0 },
            label: { show: points.length <= 12, position: "outside", fontFamily: FONT, fontSize: 10, color: ink.text, formatter: (p: { value: number }) => fmt(p.value) },
            labelLayout: { hideOverlap: true },
            markLine: hasNegative ? { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: ink.axis, width: 1, type: "solid" }, data: [{ yAxis: 0 }] } : undefined,
          }
        : {
            type: "line",
            data: points.map((p, i) => [times[i], p.value]),
            showSymbol: false,
            lineStyle: { color: ink.navy, width: 1.5 },
            itemStyle: { color: ink.navy },
            endLabel: { show: true, fontFamily: FONT, fontSize: 10, color: ink.text, formatter: (p: { value: [number, number] }) => fmt(p.value[1]) },
          },
    ],
    aria: { enabled: true },
  };

  const first = points[0];
  const last = points.at(-1);
  return (
    <figure className="flex flex-col gap-1" style={{ fontFamily: FONT }}>
      <figcaption className="flex flex-col">
        <span className="text-[13px] font-bold text-kumo-strong">
          Exhibit {number}: {title}
        </span>
        <span className="text-[11px] text-kumo-subtle">
          {unit === "%" ? "Percent" : unit ? unit : "Level"}
          {first && last ? `, ${periodLabel(first.date, period)} to ${periodLabel(last.date, period)}` : ""}
        </span>
      </figcaption>
      <div className={`border-t border-kumo-line pt-1 ${source.clickable ? "cursor-pointer" : ""}`} onClick={source.onClick}>
        <FitWidth><Chart echarts={echarts} options={options as never} height={200} isDarkMode={dark} onEvents={source.onEvents as never} /></FitWidth>
      </div>
    </figure>
  );
}

const SERIES_INK = { light: [COLOR["brand-chart"].light, "#7f93b5", "#2f6fd6", "#b8c2d3"], dark: [COLOR["brand-chart"].dark, "#9aa1ab", "#8fb8ff", "#5c6470"] };

/**
 * An analysis Exhibit (gold.exhibits): the same research-note look as `DriverExhibit`, with several series
 * (grouped columns for reported periods, thin lines for market data) and a legend when there is more than one.
 */
export function ExhibitChart({
  number,
  title,
  chart,
  series,
  points,
  sources,
  height = 220,
  symbol,
}: {
  number: number;
  title: string;
  chart: "bar" | "line";
  series: { key: string; label: string; unit: ExhibitUnit; currency: string | null; sources: string[] }[];
  points: { period: string; values: Record<string, number | null> }[];
  sources: string[];
  height?: number;
  /** The ticker whose Analysis page opens a point's source; none = the chart is not clickable. */
  symbol?: string;
}) {
  const dark = usePageDark();
  const ink = dark ? INK.dark : INK.light;
  const colours = dark ? SERIES_INK.dark : SERIES_INK.light;
  const lead = series[0];
  const fmt = (v: number) => (lead ? formatUnit(v, lead.unit, lead.currency) : String(v));
  const text = { fontFamily: FONT, fontSize: 11, color: ink.muted };
  const bars = chart === "bar";
  // A click opens the point's source: every series at that period, each value with its own providers.
  const source = useChartSource(
    symbol
      ? (x) => {
          const p = points[Math.round(x)];
          if (!p) return null;
          const shown = series.filter((s) => p.values[s.key] !== null && p.values[s.key] !== undefined);
          if (shown.length === 0) return null;
          const v = shown.map((s) => `${series.length > 1 ? `${s.label}: ` : ""}${formatUnit(p.values[s.key]!, s.unit, s.currency)}`).join(" · ");
          const tags = [...new Set(shown.flatMap((s) => (s.sources.length ? s.sources : sources)))];
          return itemHref(symbol, sourceItemId({ l: series.length === 1 ? series[0].label : title, v, d: p.period, s: tags }));
        }
      : null,
  );
  const options = {
    animation: false,
    textStyle: { fontFamily: FONT },
    grid: { left: 0, right: 16, top: 22, bottom: 4, containLabel: true },
    tooltip: {
      confine: true,
      trigger: "axis",
      axisPointer: { type: bars ? "shadow" : "line", lineStyle: { color: ink.muted, width: 1 }, shadowStyle: { color: "rgba(127,127,127,0.08)" } },
      backgroundColor: dark ? "#16191d" : "#ffffff",
      borderColor: ink.grid,
      borderWidth: 1,
      textStyle: { fontFamily: FONT, fontSize: 12, color: ink.text },
      valueFormatter: (v: number) => (v === null || v === undefined ? "–" : fmt(v)),
    },
    xAxis: {
      type: "category",
      data: points.map((p) => p.period),
      axisLine: { show: true, onZero: true, lineStyle: { color: ink.axis, width: 1 } },
      axisTick: { show: false },
      axisLabel: { ...text, color: ink.text, margin: 10, hideOverlap: true },
    },
    yAxis: { type: "value", scale: !bars, axisLine: { show: false }, axisTick: { show: false }, splitNumber: 4, splitLine: { lineStyle: { color: ink.grid, width: 1 } }, axisLabel: { ...text, formatter: (v: number) => fmt(v) } },
    series: series.map((s, i) =>
      bars
        ? {
            name: s.label,
            type: "bar",
            data: points.map((p) => p.values[s.key] ?? null),
            barMaxWidth: 28,
            itemStyle: { color: colours[i % colours.length], borderRadius: 0 },
            label: { show: series.length === 1 && points.length <= 12, position: "outside", fontFamily: FONT, fontSize: 10, color: ink.text, formatter: (p: { value: number }) => fmt(p.value) },
            labelLayout: { hideOverlap: true },
          }
        : { name: s.label, type: "line", data: points.map((p) => p.values[s.key] ?? null), showSymbol: false, connectNulls: true, lineStyle: { color: colours[i % colours.length], width: 1.5 }, itemStyle: { color: colours[i % colours.length] } },
    ),
    aria: { enabled: true },
  };
  return (
    <figure className="flex flex-col gap-1" style={{ fontFamily: FONT }}>
      <figcaption className="flex flex-col">
        <span className="text-[13px] font-bold text-kumo-strong">
          Exhibit {number}: {title}
        </span>
        {points.length > 0 && (
          <span className="text-[11px] text-kumo-subtle">
            {points[0].period} to {points.at(-1)!.period}
          </span>
        )}
      </figcaption>
      <div className={`border-t border-kumo-line pt-1 ${source.clickable ? "cursor-pointer" : ""}`} onClick={source.onClick}>
        <FitWidth><Chart echarts={echarts} options={options as never} height={height} isDarkMode={dark} onEvents={source.onEvents as never} /></FitWidth>
      </div>
      {series.length > 1 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-kumo-default">
          {series.map((s, i) => (
            <li key={s.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="h-2 w-2" style={{ background: colours[i % colours.length] }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
