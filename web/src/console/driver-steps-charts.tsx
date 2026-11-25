"use client";

import { Chart } from "@cloudflare/kumo";
import { BarChart, ScatterChart } from "echarts/charts";
import { AriaComponent, GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

import { FONT, INK } from "./driver-chart";
import { type ExhibitUnit, formatUnit } from "./exhibit-format";
import { FitWidth } from "./fit-width";
import { usePageDark } from "./use-page-dark";

echarts.use([BarChart, ScatterChart, GridComponent, TooltipComponent, AriaComponent, CanvasRenderer]);

const KINDS = ["release", "news", "filing"] as const;
const KIND_WORD = { release: "Results", news: "News", filing: "Filings" } as const;

function Legend({ items }: { items: { color: string; words: string; dot?: boolean; opacity?: number }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-kumo-default">
      {items.map((i) => (
        <li key={i.words} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={`inline-block ${i.dot ? "size-2 rounded-full" : "h-2.5 w-2.5"}`} style={{ background: i.color, opacity: i.opacity ?? 1 }} />
          {i.words}
        </li>
      ))}
    </ul>
  );
}

/**
 * The events in one sight: every event of 3 years on one time axis, one lane per kind (results, news, filings); a dot is
 * dark when the week after it was a significant unbiased move, pale otherwise.
 */
export function EventsTimeline({ events, from, to }: { events: { day: string; kind: (typeof KINDS)[number]; title: string; moved: boolean }[]; from: string; to: string }) {
  const dark = usePageDark();
  const ink = dark ? INK.dark : INK.light;
  const text = { fontFamily: FONT, fontSize: 11, color: ink.muted };
  const lane = (k: (typeof KINDS)[number]) => KINDS.indexOf(k);
  const options = {
    animation: false,
    textStyle: { fontFamily: FONT },
    aria: { enabled: true },
    tooltip: { trigger: "item", formatter: (x: { data: [string, number, string] }) => `${x.data[0]} · ${x.data[2].replace(/</g, "&lt;")}` },
    grid: { left: 64, right: 12, top: 8, bottom: 24 },
    xAxis: { type: "time", min: Date.parse(from), max: Date.parse(to), axisLine: { lineStyle: { color: ink.axis } }, axisTick: { show: false }, axisLabel: text, splitLine: { show: false } },
    yAxis: { type: "category", data: KINDS.map((k) => KIND_WORD[k]), inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: text, splitLine: { show: true, lineStyle: { color: ink.grid } } },
    series: [false, true].map((moved) => ({
      type: "scatter",
      name: moved ? "The stock moved that week" : "The stock did not move",
      symbolSize: 8,
      data: events.filter((e) => e.moved === moved).map((e) => [e.day, lane(e.kind), e.title]),
      itemStyle: { color: moved ? ink.navy : ink.muted, opacity: moved ? 1 : 0.35 },
    })),
  };
  return (
    <figure className="flex flex-col gap-2">
      <FitWidth>
        <Chart echarts={echarts} options={options as never} height={140} isDarkMode={dark} />
      </FitWidth>
      <Legend
        items={[
          { color: ink.navy, words: "Event in a week the stock moved", dot: true },
          { color: ink.muted, words: "Event, the stock did not move", dot: true, opacity: 0.35 },
        ]}
      />
    </figure>
  );
}

/**
 * A KPI in one sight: its value at each period (half years for a Hong Kong company), a column per period labelled with
 * its value and the stretch it covers; coloured when its change on a year earlier was judged big enough to matter.
 */
export function KpiPeriodsChart({ periods, unit, currency, label }: { periods: { date: string; period: string; value: number; significant: boolean }[]; unit: ExhibitUnit; currency: string | null; label: string }) {
  const dark = usePageDark();
  const ink = dark ? INK.dark : INK.light;
  const text = { fontFamily: FONT, fontSize: 11, color: ink.muted };
  const options = {
    animation: false,
    textStyle: { fontFamily: FONT },
    aria: { enabled: true },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => formatUnit(v, unit, currency) },
    grid: { left: 64, right: 12, top: 40, bottom: 24 },
    xAxis: { type: "category", data: periods.map((p) => p.period), axisLine: { lineStyle: { color: ink.axis } }, axisTick: { show: false }, axisLabel: { ...text, interval: 0, fontSize: 10 } },
    yAxis: { type: "value", name: label, nameTextStyle: { ...text, align: "left" }, axisLabel: { ...text, formatter: (v: number) => formatUnit(v, unit, currency) }, splitLine: { lineStyle: { color: ink.grid } } },
    series: [
      {
        type: "bar",
        name: label,
        barMaxWidth: 28,
        data: periods.map((p) => ({ value: p.value, itemStyle: { color: p.significant ? ink.navy : ink.muted, opacity: p.significant ? 1 : 0.4 } })),
        label: { show: periods.length <= 12, position: "top", fontFamily: FONT, fontSize: 10, color: ink.muted, formatter: (x: { value: number }) => formatUnit(x.value, unit, currency) },
      },
    ],
  };
  return (
    <figure className="flex flex-col gap-2">
      <FitWidth>
        <Chart echarts={echarts} options={options as never} height={220} isDarkMode={dark} />
      </FitWidth>
      <Legend
        items={[
          { color: ink.navy, words: "Moved enough to matter, on a year earlier" },
          { color: ink.muted, words: "A small change, or no year earlier to compare", opacity: 0.4 },
        ]}
      />
    </figure>
  );
}
