import Link from "./link";
import { itemHref } from "./item-href";

/**
 * SOURCES-ONE-CLICK-1123 (Kevin 2026-11-23: « les sources sont tjs accessibles, mais pas besoin de le répéter tout le
 * tps… une façon homogène partout »). ONE gesture in the whole console: click the figure or the quote itself. A sourced
 * figure or quote wears a thin dotted underline, the same everywhere, and opens its source in the right panel:
 * - a company document = `doc:<id>:<page>:<quote>` (the page, the sentence highlighted, « Open document ↗ »);
 * - a data figure = `src:<payload>` (its series, the providers by name, the date): `sourceItemId`.
 * Never a « Source: … » line under a chart or at the bottom of a panel, never a badge row of providers.
 * Charts open the same `src:` panel for the point clicked (`driver-chart.tsx`, `price-fair-chart.tsx`).
 */

/** What a data figure's source panel shows: label, value as printed, date or period, source tags (providers), optional original link. */
export type SourcePayload = { l: string; v?: string; d?: string; s: string[]; u?: string };

export const sourceItemId = (p: SourcePayload) => `src:${JSON.stringify(p)}`;

export function parseSourceItem(key: string): SourcePayload | null {
  try {
    const p = JSON.parse(key) as Partial<SourcePayload>;
    if (typeof p.l !== "string" || !Array.isArray(p.s) || !p.s.every((x) => typeof x === "string")) return null;
    return {
      l: p.l,
      v: typeof p.v === "string" ? p.v : undefined,
      d: typeof p.d === "string" ? p.d : undefined,
      s: p.s,
      u: typeof p.u === "string" && /^https:\/\//.test(p.u) ? p.u : undefined,
    };
  } catch {
    return null;
  }
}

/** The dotted underline every sourced figure or quote wears. No hover effect (Kevin dislikes effects). */
export const SOURCED_CLASS = "cursor-pointer underline decoration-dotted decoration-1 underline-offset-[3px]";

/** A figure or quote whose source opens in the right panel of the Analysis page (`item` = `doc:…` or `sourceItemId(…)`). */
export function Sourced({ symbol, item, className = "", children }: { symbol: string; item: string; className?: string; children: React.ReactNode }) {
  return (
    <Link href={itemHref(symbol, item)} scroll={false} className={`${SOURCED_CLASS} ${className}`}>
      {children}
    </Link>
  );
}

/** Shortcut: a data figure (value as printed) opening its series, providers and date. */
export function SourcedFigure({ symbol, source, className, children }: { symbol: string; source: SourcePayload; className?: string; children: React.ReactNode }) {
  return (
    <Sourced symbol={symbol} item={sourceItemId(source)} className={className}>
      {children}
    </Sourced>
  );
}
