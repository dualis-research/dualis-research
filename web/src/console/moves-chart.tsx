"use client";

import { Chart } from "@cloudflare/kumo";
import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { LineChart, ScatterChart } from "echarts/charts";
import { AriaComponent, GridComponent, MarkAreaComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

import { FONT, INK } from "./driver-chart";
import { FitWidth } from "./fit-width";
import { day } from "./format";
import { openPanel } from "./item-nav";
import { itemHref } from "./item-href";
import type { PricePoint } from "./kpi-driver-chart";
import Link from "./link";
import { arrowGroups, arrowWords, type MoveArrow } from "./move-arrows";
import { usePageDark } from "./use-page-dark";
import { COLOR } from "@/design/tokens";

echarts.use([LineChart, ScatterChart, GridComponent, MarkAreaComponent, AriaComponent, CanvasRenderer]);

const UP = "path://M5,0 L10,9 L6.5,9 L6.5,16 L3.5,16 L3.5,9 L0,9 Z";
const DOWN = "path://M3.5,0 L6.5,0 L6.5,7 L10,7 L5,16 L0,7 L3.5,7 Z";
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

/**
 * Step 2 « When the stock moved » with what happened at each move (MOVE-ARROWS-1123, Thierry 2026-11-23: « a chart
 * with arrows pointing at each thing, telling me: this is what happened here »). The share price with its market taken
 * out; each unusual move shaded over its days and marked by a numbered arrow, up ones in a band above the line, down
 * ones in a band below it, so neither the numbers nor the arrows ever cover the line; the words sit in the numbered
 * list under the chart. A click on an arrow or a row opens the move's panel.
 */
export function MovesChart({ symbol, price, indexName, arrows, height = 280 }: { symbol: string; price: PricePoint[]; indexName: string; arrows: MoveArrow[]; height?: number }) {
  const dark = usePageDark();
  const router = useRouter();
  const ink = dark ? INK.dark : INK.light;
  const tone = { up: COLOR.long[dark ? "dark" : "light"], down: COLOR.short[dark ? "dark" : "light"] };
  const text = { fontFamily: FONT, fontSize: 11, color: ink.muted };
  const values = price.flatMap((x) => [x.raw, x.clean]);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  const pad = (hi - lo || hi || 1) * 0.22;
  const yMin = lo - pad;
  const yMax = hi + pad;
  const span = price.length ? (Date.parse(price.at(-1)!.date) - Date.parse(price[0].date)) / 86_400_000 : 0;
  const groups = arrowGroups(arrows, span);
  const moveHref = (id: string) => itemHref(symbol, `move:${id}`);
  const open = (id: string) => {
    const href = moveHref(id);
    if (!openPanel(href)) router.push(href, { scroll: false });
  };
  const marks = groups.map((g) => ({
    value: [Date.parse(`${g.day}T00:00:00Z`), g.direction === "up" ? hi + pad * 0.5 : lo - pad * 0.5],
    id: g.arrows[0].id,
    symbol: g.direction === "up" ? UP : DOWN,
    itemStyle: { color: tone[g.direction] },
    label: { show: true, position: "right", distance: 3, formatter: g.arrows.map((a) => a.n).join(", "), color: tone[g.direction], fontFamily: FONT, fontSize: 11, fontWeight: 700 },
  }));
  const options = {
    animation: false,
    textStyle: { fontFamily: FONT },
    aria: { enabled: true },
    grid: { left: 56, right: 24, top: 12, bottom: 24 },
    xAxis: {
      type: "time",
      min: price[0] ? Date.parse(price[0].date) : undefined,
      max: price.at(-1) ? Date.parse(price.at(-1)!.date) : undefined,
      axisLine: { lineStyle: { color: ink.axis } },
      axisTick: { show: false },
      axisLabel: text,
      splitLine: { show: false },
    },
    yAxis: { type: "value", min: yMin, max: yMax, axisLabel: { ...text, showMinLabel: false, showMaxLabel: false, formatter: (v: number) => v.toFixed(2) }, splitLine: { lineStyle: { color: ink.grid } } },
    series: [
      { type: "line", name: "Share price", data: price.map((x) => [x.date, x.raw]), showSymbol: false, silent: true, lineStyle: { color: ink.muted, width: 1, opacity: 0.5 } },
      {
        type: "line",
        name: `Market taken out (${indexName})`,
        data: price.map((x) => [x.date, x.clean]),
        showSymbol: false,
        silent: true,
        lineStyle: { color: ink.navy, width: 1.75 },
        markArea: { silent: true, data: arrows.map((a) => [{ xAxis: a.startDay, itemStyle: { color: tone[a.direction], opacity: 0.16 } }, { xAxis: a.endDay }]) },
      },
      { type: "scatter", name: "Unusual move", data: marks, symbolSize: [10, 16], z: 4, cursor: "pointer" },
    ],
  };
  const swatch = (color: string, w: number, h: number, opacity = 1) => <span aria-hidden className="inline-block" style={{ background: color, width: w, height: h, opacity }} />;
  const first = price[0]?.date;
  const last = price.at(-1)?.date;
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
              if (p.seriesName === "Unusual move" && id) open(id);
            },
          }}
        />
      </FitWidth>
      {/* What each colour, line and mark means, and which dates the chart covers (Kevin 2026-11-23). */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-kumo-default">
        <li className="inline-flex items-center gap-1.5">
          <ArrowUpIcon size={12} weight="bold" aria-hidden style={{ color: tone.up }} />
          {`Up at least 2x its usual 5-day move, ${indexName} taken out`}
        </li>
        <li className="inline-flex items-center gap-1.5">
          <ArrowDownIcon size={12} weight="bold" aria-hidden style={{ color: tone.down }} />
          {`Down at least 2x its usual 5-day move, ${indexName} taken out`}
        </li>
        <li className="inline-flex items-center gap-1.5">
          {swatch(ink.muted, 10, 10, 0.25)}
          Days of the move
        </li>
        <li className="inline-flex items-center gap-1.5">
          {swatch(ink.muted, 14, 2, 0.5)}
          Share price
        </li>
        <li className="inline-flex items-center gap-1.5">
          {swatch(ink.navy, 14, 2)}
          {`Share price, ${indexName} taken out`}
        </li>
        {first && last && <li className="text-kumo-subtle">{`Daily closes, ${day(first)} to ${day(last)}`}</li>}
      </ul>
      <ol className="flex flex-col">
        {arrows.map((a) => (
          <li key={a.id}>
            <Link href={moveHref(a.id)} scroll={false} className="-mx-2 grid grid-cols-[2rem_11.5rem_4rem_1fr] items-baseline gap-x-3 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-kumo-tint">
              <span className="inline-flex items-center gap-0.5 font-semibold tabular" style={{ color: tone[a.direction] }}>
                {a.direction === "up" ? <ArrowUpIcon size={12} weight="bold" aria-hidden /> : <ArrowDownIcon size={12} weight="bold" aria-hidden />}
                {a.n}
              </span>
              <span className="tabular text-kumo-subtle">{a.startDay === a.endDay ? day(a.startDay) : `${day(a.startDay)} to ${day(a.endDay)}`}</span>
              <span className="tabular font-semibold" style={{ color: tone[a.direction] }}>
                {pct(a.abnormal)}
              </span>
              <span className={a.candidates.length || a.fact ? "text-kumo-default" : "text-kumo-subtle"}>{arrowWords(a)}</span>
            </Link>
          </li>
        ))}
      </ol>
    </figure>
  );
}
