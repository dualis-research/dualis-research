"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";
import { openPanel } from "./item-nav";

/**
 * A click on a chart opens the source of the point under the pointer (SOURCES-ONE-CLICK-1123): the same `src:` panel a
 * dotted-underlined figure opens. The axis pointer already follows the pointer (`updateAxisPointer`): we keep the axis
 * value it sits on, and a click on the chart opens `hrefAt(that value)`. `skip()` lets a series' own click (a move
 * marker) win over it. No href (no ticker page) = nothing happens.
 */
export function useChartSource(hrefAt: ((axisValue: number) => string | null) | null) {
  const router = useRouter();
  const at = useRef<number | null>(null);
  const skipped = useRef(false);
  const onEvents = {
    updateAxisPointer: (e: { axesInfo?: { axisDim?: string; value?: number }[] }) => {
      const x = e.axesInfo?.find((a) => a.axisDim === "x");
      at.current = typeof x?.value === "number" ? x.value : null;
    },
  };
  const onClick = () => {
    if (skipped.current) {
      skipped.current = false;
      return;
    }
    if (!hrefAt || at.current === null) return;
    const href = hrefAt(at.current);
    if (href && !openPanel(href)) router.push(href, { scroll: false });
  };
  return { onEvents, onClick, clickable: !!hrefAt, skip: () => (skipped.current = true) };
}

/** The point of a time series nearest to a time-axis value. */
export function nearestIndex(times: number[], t: number): number {
  let best = 0;
  for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
  return best;
}
