import { Badge } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, TrendUpIcon } from "@phosphor-icons/react/ssr";
import Link from "@/console/link";
import { findQuote } from "@/collectors/dimensions/filing-documents/text";
import type { DocCitation, GoldNarrativeState, GoldPriceMove, GoldPriceMoveCause, ThesisSide } from "@/db/schema/analysis";
import { docItemId } from "./document-page";
import { SOURCED_CLASS } from "./sourced";
import { Drawer, Drawers } from "./drawer";
import { TagBadge } from "./tag-badge";
import { Rich } from "./rich";

/**
 * The top of a Narrative Driver panel (INFLECTION-1117, Kevin 2026-11-17: « la raison doit être résumée très clairement
 * et le plus concisément possible en haut… le détail est disponible en dessous »): the reason in one sentence with its
 * tag (« Weak inflection · Structural »), then What changed (management's words, each quote dotted-underlined, one click from its page),
 * then What moved the stock (the significant moves that made it a driver). Pure: the panel and its test render it.
 */

const signed = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const shortDay = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The explanation's words without the bold marks, and where each bold run sits in them. */
function boldRuns(shown: string): { text: string; bold: [number, number][] } {
  const parts = shown.split("**");
  let text = "";
  const bold: [number, number][] = [];
  parts.forEach((p, i) => {
    // An odd part is inside a pair of marks; a lone last mark is dropped, never shown (as `Rich` does).
    if (i % 2 === 1 && i < parts.length - 1) bold.push([text.length, text.length + p.length]);
    text += p;
  });
  return { text, bold };
}

/**
 * The explanation, each quoted passage dotted-underlined: a click opens the document page with the passage highlighted
 * (SOURCES-ONE-CLICK-1123: the quote itself is the link, no chip). A quote not printed in the explanation follows it,
 * in « », underlined the same way.
 */
export function ExplanationWithCitations({ text: shown, citations, hrefFor }: { text: string; citations: DocCitation[]; hrefFor: (item: string) => string }) {
  const { text, bold } = boldRuns(shown);
  const words = (from: number, to: number, key: string) => {
    const out: React.ReactNode[] = [];
    let at = from;
    for (const [b, e] of bold) {
      if (e <= at || b >= to) continue;
      if (b > at) out.push(text.slice(at, b));
      out.push(
        <strong key={`${key}b${b}`} className="font-semibold text-kumo-strong">
          {text.slice(Math.max(b, at), Math.min(e, to))}
        </strong>,
      );
      at = Math.min(e, to);
    }
    if (at < to) out.push(text.slice(at, to));
    return out;
  };
  const href = (c: DocCitation) => hrefFor(docItemId(c.documentId, c.page, c.quote));
  const found = citations
    .map((c, i) => ({ c, i, at: findQuote(text, c.quote) }))
    .filter((x): x is { c: DocCitation; i: number; at: [number, number] } => x.at !== null)
    .sort((a, b) => a.at[0] - b.at[0]);
  const parts: React.ReactNode[] = [];
  const placed = new Set<number>();
  let cursor = 0;
  for (const p of found) {
    if (p.at[0] < cursor) continue;
    parts.push(...words(cursor, p.at[0], `t${cursor}`));
    parts.push(
      <Link key={`c${p.i}`} href={href(p.c)} scroll={false} className={SOURCED_CLASS}>
        {words(p.at[0], p.at[1], `q${p.i}`)}
      </Link>,
    );
    placed.add(p.i);
    cursor = p.at[1];
  }
  parts.push(...words(cursor, text.length, `t${cursor}`));
  const rest = citations.filter((_, i) => !placed.has(i));
  return (
    <p className="text-base leading-relaxed text-kumo-default">
      {parts}
      {rest.map((c, i) => (
        <span key={`r${i}`}>
          {" "}
          <Link href={href(c)} scroll={false} className={SOURCED_CLASS}>
            « {c.quote} »
          </Link>
        </span>
      ))}
    </p>
  );
}

export type DriverMove = GoldPriceMove & { cause: GoldPriceMoveCause | null };

export function DriverReason({ state, side, moves, hrefFor, children }: { state: GoldNarrativeState | null; side: ThesisSide; moves: DriverMove[]; hrefFor: (item: string) => string; /** More drawers of the panel, after these. */ children?: React.ReactNode }) {
  const top = state?.reason ?? state?.why ?? null;
  const m = state?.magnitude;
  return (
    <>
      {state && (
        <div className="flex flex-col gap-3">
          <span className="flex flex-wrap items-center gap-2">
            <TagBadge effect={state.effect} strength={state.strength} side={side} durability={state.durability} />
            {m && (
              <Badge variant="outline">
                {`${m.figure}${m.from && m.to ? `: ${m.from} to ${m.to}` : ""}${m.change ? ` (${m.change})` : ""}`}
              </Badge>
            )}
          </span>
          {top && <p className="text-xl leading-snug text-kumo-strong"><Rich text={top} /></p>}
        </div>
      )}
      <Drawers>
      {state?.explanation && (
        <Drawer icon={<ArrowsClockwiseIcon size={16} aria-hidden />} title="What changed">
          <ExplanationWithCitations text={state.explanation} citations={state.citations ?? []} hrefFor={hrefFor} />
        </Drawer>
      )}
      {moves.length > 0 && (
        <Drawer icon={<TrendUpIcon size={16} aria-hidden />} title={`What moved the stock · ${moves.length}`}>
          <ul className="flex flex-col gap-3">
            {moves.map((x) => (
              <li key={x.id}>
                <Link href={hrefFor(`move:${x.id}`)} scroll={false} className="flex flex-col gap-1 hover:underline">
                  <span className="text-base font-medium text-kumo-strong">
                    {`${x.direction === "up" ? "Rise" : "Fall"} of ${signed(x.returnPct)} on ${shortDay(x.startDay)}`} <span className="text-kumo-subtle">›</span>
                  </span>
                  {x.cause?.fact && <span className="text-sm text-kumo-default"><Rich text={x.cause.fact} /></span>}
                </Link>
              </li>
            ))}
          </ul>
        </Drawer>
      )}
      {children}
      </Drawers>
    </>
  );
}
