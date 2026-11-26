"use client";

import { Chart } from "@cloudflare/kumo";
import { useRouter } from "next/navigation";
import { LineChart, ScatterChart } from "echarts/charts";
import { AriaComponent, DataZoomComponent, GridComponent, MarkAreaComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

import { FONT, INK } from "./driver-chart";
import { FitWidth } from "./fit-width";
import { day } from "./format";
import { openPanel } from "./item-nav";
import { itemHref } from "./item-href";
import Link from "./link";
import { usePageDark } from "./use-page-dark";
import { COLOR } from "@/design/tokens";

echarts.use([LineChart, ScatterChart, GridComponent, MarkAreaComponent, DataZoomComponent, AriaComponent, CanvasRenderer]);

export type StoryEpisodeView = { id: string; startDay: string; endDay: string; cause: "company" | "industry" | "macro"; title: string; returnPct: number | null; bench: string; benchReturn: number | null };

export const CAUSE_WORD = { company: "Company", industry: "Industry", macro: "Macro" } as const;
const toneOf = (e: StoryEpisodeView, dark: boolean) => ((e.returnPct ?? 0) >= 0 ? COLOR.long : COLOR.short)[dark ? "dark" : "light"];
const pct = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`);
/** Boxes sit on 2 rows above the price and 2 below, in turn, so neighbours never cover each other. */
const ROWS = [0.9, 0.62, -0.62, -0.9] as const;
const DOWN = "path://M0,0 L10,0 L5,8 Z";
const UP = "path://M5,0 L10,8 L0,8 Z";

/**
 * Step F · Stock story (Thierry, call 2026-11-26: « a price chart… and just like an arrow with a box of text: what was
 * the move here »). The share price as traded, no fair value; each episode shaded over its days, with a numbered box
 * of its few-word title always visible, pointing at the price; wheel or pinch to zoom, the slider under it to pan. A
 * click on a box or a row opens the episode's panel (its sentence and its events).
 */
export function StoryChart({ symbol, price, episodes, height = 460 }: { symbol: string; price: { date: string; raw: number }[]; episodes: StoryEpisodeView[]; height?: number }) {
  const dark = usePageDark();
  const router = useRouter();
  const ink = dark ? INK.dark : INK.light;
  const tone = (e: StoryEpisodeView) => toneOf(e, dark);
  const text = { fontFamily: FONT, fontSize: 11, color: ink.muted };
  const values = price.map((x) => x.raw);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  const span = hi - lo || hi || 1;
  // Room above and below the line for the boxes.
  const yMin = lo - span * 0.75;
  const yMax = hi + span * 0.75;
  const mid = (lo + hi) / 2;
  const href = (id: string) => itemHref(symbol, `story:${id}`);
  const open = (id: string) => {
    const h = href(id);
    if (!openPanel(h)) router.push(h, { scroll: false });
  };
  const at = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const boxes = episodes.map((e, i) => {
    const row = ROWS[i % ROWS.length];
    const above = row > 0;
    return {
      value: [(at(e.startDay) + at(e.endDay)) / 2, mid + row * (span / 2 + span * 0.55)],
      id: e.id,
      symbol: above ? DOWN : UP,
      symbolSize: [10, 8],
      itemStyle: { color: tone(e) },
      label: {
        show: true,
        position: above ? "top" : "bottom",
        distance: 4,
        formatter: `{n|${i + 1}} ${e.title}`,
        width: 150,
        overflow: "break",
        lineHeight: 14,
        padding: [4, 6],
        borderRadius: 4,
        borderWidth: 1,
        borderColor: tone(e),
        backgroundColor: dark ? "#14161a" : "#ffffff",
        color: ink.text,
        fontFamily: FONT,
        fontSize: 11,
        rich: { n: { fontWeight: 700, color: tone(e), fontFamily: FONT, fontSize: 11 } },
      },
    };
  });
  const options = {
    animation: false,
    textStyle: { fontFamily: FONT },
    aria: { enabled: true },
    grid: { left: 56, right: 24, top: 16, bottom: 64 },
    xAxis: {
      type: "time",
      min: price[0] ? at(price[0].date) : undefined,
      max: price.at(-1) ? at(price.at(-1)!.date) : undefined,
      axisLine: { lineStyle: { color: ink.axis } },
      axisTick: { show: false },
      axisLabel: text,
      splitLine: { show: false },
    },
    yAxis: { type: "value", min: yMin, max: yMax, axisLabel: { ...text, showMinLabel: false, showMaxLabel: false, formatter: (v: number) => (v < lo || v > hi ? "" : v.toFixed(2)) }, splitLine: { show: false } },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none" },
      { type: "slider", xAxisIndex: 0, filterMode: "none", height: 22, bottom: 12, borderColor: ink.grid, textStyle: text, showDetail: false },
    ],
    series: [
      {
        type: "line",
        name: "Share price",
        data: price.map((x) => [x.date, x.raw]),
        showSymbol: false,
        silent: true,
        lineStyle: { color: ink.navy, width: 1.75 },
        markArea: { silent: true, data: episodes.map((e) => [{ xAxis: e.startDay, itemStyle: { color: tone(e), opacity: 0.14 } }, { xAxis: e.endDay }]) },
      },
      { type: "scatter", name: "Episode", data: boxes, z: 4, cursor: "pointer" },
    ],
  };
  const first = price[0]?.date;
  const last = price.at(-1)?.date;
  const swatch = (color: string, w: number, h: number, opacity = 1) => <span aria-hidden className="inline-block" style={{ background: color, width: w, height: h, opacity }} />;
  return (
    <figure className="flex flex-col gap-3">
      <FitWidth>
        <Chart
          echarts={echarts}
          options={options as never}
          height={height}
          isDarkMode={dark}
          onEvents={{
            click: (p: { seriesName?: string; data?: unknown }) => {
              const id = (p.data as { id?: string } | undefined)?.id;
              if (p.seriesName === "Episode" && id) open(id);
            },
          }}
        />
      </FitWidth>
      {/* What each colour, line and box means, and which dates the chart covers (Kevin 2026-11-23). */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-kumo-default">
        <li className="inline-flex items-center gap-1.5">
          {swatch(ink.navy, 14, 2)}
          Share price
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-flex">
            {swatch(COLOR.long[dark ? "dark" : "light"], 5, 10, 0.3)}
            {swatch(COLOR.short[dark ? "dark" : "light"], 5, 10, 0.3)}
          </span>
          Days of an episode, the stock up or down over it
        </li>
        <li>Numbered box: what moved the price then</li>
        {first && last && <li className="text-kumo-subtle">{`Daily closes, ${day(first)} to ${day(last)}; scroll or pinch to zoom`}</li>}
      </ul>
    </figure>
  );
}

/** The episodes as a numbered list under the chart, each row opening its panel (no hook: renders on the server too). */
export function StoryList({ symbol, episodes }: { symbol: string; episodes: StoryEpisodeView[] }) {
  return (
    <ol className="flex flex-col">
      {episodes.map((e, i) => (
        <li key={e.id}>
          <Link href={itemHref(symbol, `story:${e.id}`)} scroll={false} className="-mx-2 grid grid-cols-[2rem_11.5rem_4.5rem_4rem_1fr] items-baseline gap-x-3 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-kumo-tint">
            <span className="font-semibold tabular" style={{ color: toneOf(e, false) }}>
              {i + 1}
            </span>
            <span className="tabular text-kumo-subtle">{e.startDay === e.endDay ? day(e.startDay) : `${day(e.startDay)} to ${day(e.endDay)}`}</span>
            <span className="text-kumo-subtle">{CAUSE_WORD[e.cause]}</span>
            <span className="tabular font-semibold" style={{ color: toneOf(e, false) }}>
              {pct(e.returnPct)}
            </span>
            <span className="text-kumo-default">{e.title}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
