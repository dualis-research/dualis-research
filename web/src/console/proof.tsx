import { ArrowsDownUpIcon, BookOpenTextIcon, CalendarDotsIcon, ChartBarIcon, CompassIcon, FileTextIcon, GaugeIcon, LightbulbIcon, ListChecksIcon, MagnifyingGlassIcon, SealCheckIcon, SirenIcon, TrendUpIcon } from "@phosphor-icons/react/ssr";
import { Badge } from "@cloudflare/kumo";
import type { DriverReversal, GoldDriverEvent, GoldKpiDriver, KpiEventRow } from "@/db/schema/analysis";
import { reversalWord, STATE_WORD, turnsAgainst } from "@/content/reversal-words";
import { PRICED_WORD } from "@/content/signal-words";
import { decodeEntities } from "@/collectors/dimensions/content-posts/parse";
import { HISTORY_YEARS } from "@/collectors/history";
import { kpiChange, kpiValue, periodWords } from "@/collectors/dimensions/kpi-drivers/steps";
import { ConfidenceBadge } from "./confidence-badge";
import { docItemId } from "./document-page";
import { Drawer, Drawers } from "./drawer";
import { EventsTimeline } from "./driver-steps-charts";
import { day, relativeTime } from "./format";
import { itemHref } from "./item-href";
import { proofData, type ProofData } from "./kpi-queries";
import Link from "./link";
import { NO_EVENT, type MoveArrow } from "./move-arrows";
import { MovesChart } from "./moves-chart";
import { Rich } from "./rich";
import { Sourced, SourcedFigure, sourceItemId } from "./sourced";

/**
 * The analysis of a stock, exactly the five steps of docs/architecture.md (Kevin 2026-11-25) in their order, each
 * closed by default, its title carrying its conclusion, so the page reads closed in seconds:
 * A · Price Driver Candidates: the events, the significant unbiased 1-week moves, the events of each move (what the AI
 *     read), the candidates it deduced.
 * B · Price Drivers: per candidate, the two tests (each significant change -> a significant move the week after? each
 *     significant move -> did it change on its first day?) and the AI's confidence strong | weak | noise. The panel
 *     lists the Price Drivers only and the latest events, each with a link to the whole list on the Analysis page.
 * C · Narrative: pessimistic or optimistic, the AI's confidence that the market holds it, and one sentence per Price
 *     Driver that explains it, each under its real name.
 * D · Reversals (only when C is weak or strong): each Price Driver in continuation, reversal or noise, with its own
 *     direction, its leading indicator and the company's words.
 * E · Signal: is the narrative turning? strong | weak | noise.
 * Every figure, quote and event is one click from its source. The same blocks render on the Analysis page, in the
 * ticker panel and (B then D of one driver) in the `kdriver:` panel.
 */

const KIND = { release: "Results", news: "News", filing: "Filing" } as const;
/** How a candidate's kind reads on screen (meeting 2026-11-23: a KPI, a policy, or a qualitative industry fact). */
export const CANDIDATE_KIND_WORD = { kpi: "KPI", policy: "Policy", industry: "Industry" } as const;
const LEVEL_RANK = { strong: 0, weak: 1, none: 2 } as const;
const pct = (x: number | null) => (x === null ? "–" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const trusted = (k: Pick<GoldKpiDriver, "level">) => k.level === "strong" || k.level === "weak";

/** An event's title, one click on it opens its source: the report's pages for a release, else the publisher's or registry's page. */
export function EventTitle({ symbol, e }: { symbol: string; e: Pick<GoldDriverEvent, "kind" | "sourceId" | "title" | "day" | "url"> }) {
  const title = decodeEntities(e.title.replace(/\s+/g, " "));
  if (e.kind === "release") return <Sourced symbol={symbol} item={docItemId(e.sourceId, 1)}>{title}</Sourced>;
  if (e.url && /^https:\/\//.test(e.url)) return <Sourced symbol={symbol} item={sourceItemId({ l: title, d: e.day, s: [], u: e.url })}>{title}</Sourced>;
  return <>{title}</>;
}

/** A section or drawer title: its name, then its conclusion (« 2 strong, 3 weak »). */
function Title({ name, conclusion, big = false }: { name: string; conclusion: React.ReactNode; big?: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className={big ? "text-xl font-semibold text-kumo-strong" : "text-kumo-strong"}>{name}</span>
      <span className={`flex items-center gap-2 font-normal text-kumo-default ${big ? "text-lg" : ""}`}>{conclusion}</span>
    </span>
  );
}

/** The significant unbiased 1-week moves in a row, numbered, green up and red down; `marked` rings the ones a test points at. */
function WeekStrip({ arrows, marked }: { arrows: MoveArrow[]; marked?: Set<string> }) {
  return (
    <figure className="flex flex-col gap-2">
      <ol className="flex flex-wrap gap-1.5">
        {arrows.map((a) => (
          <li key={a.id} title={`${day(a.startDay)}: ${pct(a.abnormal)}`} className={`inline-flex size-8 items-center justify-center rounded-md text-xs font-semibold tabular ${a.direction === "up" ? "bg-dualis-long-soft text-dualis-long" : "bg-dualis-short-soft text-dualis-short"} ${marked?.has(a.id) ? "outline-2 outline-offset-2 outline-kumo-brand" : ""}`}>
            {a.n}
          </li>
        ))}
      </ol>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-kumo-default">
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block size-2.5 rounded-sm bg-dualis-long-soft" />Significant move up</li>
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block size-2.5 rounded-sm bg-dualis-short-soft" />Significant move down</li>
        {marked && <li className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block size-2.5 rounded-sm outline-2 outline-kumo-brand" />The candidate changed on its first day</li>}
        {arrows[0] && <li className="text-kumo-subtle">{`1-week moves with the market taken out, numbered in date order, ${day(arrows[0].startDay)} to ${day(arrows.at(-1)!.endDay)}`}</li>}
      </ul>
    </figure>
  );
}

/** A KPI's reported values as columns, the ones whose change was judged to matter in indigo (cheap: no chart library). */
function PeriodStrip({ k }: { k: Pick<GoldKpiDriver, "periods" | "measure" | "name"> }) {
  const m = k.measure;
  if (!m || k.periods.length === 0) return null;
  const values = k.periods.map((p) => p.value);
  const lo = Math.min(0, ...values);
  const hi = Math.max(...values, lo + 1e-9);
  return (
    <figure className="flex flex-col gap-2">
      <ol className="flex h-36 items-end gap-1.5">
        {k.periods.map((p) => (
          <li key={p.period} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${periodWords(p.periodType, p.period)}: ${kpiValue(p.value, m)}`}>
            <span className="text-[10px] text-kumo-subtle tabular">{kpiValue(p.value, m)}</span>
            <span className={`w-full max-w-7 rounded-t-sm ${p.significant ? "bg-kumo-brand" : "bg-kumo-line"}`} style={{ height: `${Math.max(3, ((p.value - lo) / (hi - lo)) * 100)}px` }} />
            <span className="text-[10px] text-kumo-subtle tabular">{`${p.period.slice(2, 4)}-${p.period.slice(5, 7)}`}</span>
          </li>
        ))}
      </ol>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-kumo-default">
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block size-2.5 rounded-sm bg-kumo-brand" />Changed enough to matter, on a year earlier</li>
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block size-2.5 rounded-sm bg-kumo-line" />A small change</li>
        <li className="text-kumo-subtle">{`${m.label}, period end YY-MM`}</li>
      </ul>
    </figure>
  );
}

function EventList({ symbol, events, industry }: { symbol: string; events: GoldDriverEvent[]; industry: Set<string> }) {
  return (
    <ul className="flex flex-col">
      {[...events].reverse().map((e) => (
        <li key={e.id} className="grid grid-cols-[6.5rem_5.5rem_1fr] gap-3 border-b border-kumo-hairline py-2 text-sm last:border-b-0">
          <span className="tabular text-kumo-subtle">{day(e.day)}</span>
          <span className="text-kumo-subtle">{e.kind === "news" && industry.has(e.sourceId) ? "Industry" : KIND[e.kind]}</span>
          <span className="min-w-0 text-kumo-default">
            <EventTitle symbol={symbol} e={e} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Step A's reading material: for each significant move, the events whose week it was, each opening its source. */
function WeekEvents({ symbol, arrows, industry }: { symbol: string; arrows: MoveArrow[]; industry: Set<string> }) {
  return (
    <ol className="flex flex-col">
      {arrows.map((a) => (
        <li key={a.id} className="grid grid-cols-[2rem_11.5rem_4rem_1fr] items-baseline gap-x-3 border-b border-kumo-hairline py-2 text-sm last:border-b-0">
          <Link href={itemHref(symbol, `move:${a.id}`)} scroll={false} className={`font-semibold tabular ${a.direction === "up" ? "text-dualis-long" : "text-dualis-short"}`}>
            {a.n}
          </Link>
          <span className="tabular text-kumo-subtle">{a.startDay === a.endDay ? day(a.startDay) : `${day(a.startDay)} to ${day(a.endDay)}`}</span>
          <span className={`tabular font-semibold ${a.direction === "up" ? "text-dualis-long" : "text-dualis-short"}`}>{pct(a.abnormal)}</span>
          {a.events.length ? (
            <ul className="flex flex-col gap-0.5 text-kumo-default">
              {a.events.map((e) => (
                <li key={e.id}>
                  {`${day(e.day)} · ${e.kind === "news" && industry.has(e.sourceId) ? "Industry" : KIND[e.kind]}: `}
                  <EventTitle symbol={symbol} e={e} />
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-kumo-subtle">{NO_EVENT}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

const measuredWord = (k: Pick<GoldKpiDriver, "kind" | "measure">) => (k.kind === "kpi" && k.measure ? `Measured: ${k.measure.label}` : "Read in events");

function CandidateList({ symbol, kpis }: { symbol: string; kpis: GoldKpiDriver[] }) {
  return (
    <ol className="flex flex-col">
      {kpis.map((k) => (
        <li key={k.id}>
          <Link href={itemHref(symbol, `kdriver:${k.id}`)} scroll={false} className="-mx-3 flex flex-col gap-0.5 rounded-lg px-3 py-2.5 transition-colors hover:bg-kumo-tint">
            <span className="text-base font-semibold text-kumo-strong">{k.name}</span>
            <span className="text-sm text-kumo-subtle">
              {`${CANDIDATE_KIND_WORD[k.kind]} · ${measuredWord(k)} · ${k.foundIn.length ? `read in ${plural(k.foundIn.length, "event")} of a significant move` : "read in no stored event"}`}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

/** What a candidate's change at one event reads as: the KPI's figures for its period, or « Better / Worse » for a policy or an industry fact. */
function ChangeWords({ symbol, k, r }: { symbol: string; k: GoldKpiDriver; r: KpiEventRow }) {
  const p = r.period ? k.periods.find((x) => x.period === r.period) : undefined;
  if (p && k.measure) {
    const to = kpiValue(r.to, k.measure);
    const figure = p.cite ? (
      <Sourced symbol={symbol} item={docItemId(p.cite.documentId, p.cite.page, p.cite.quote)}>{to}</Sourced>
    ) : (
      <SourcedFigure symbol={symbol} source={{ l: k.measure.label, v: to, d: periodWords(p.periodType, p.period), s: k.measure.providers }}>{to}</SourcedFigure>
    );
    return (
      <span>
        {`${periodWords(p.periodType, p.period)}: ${kpiValue(r.from, k.measure)} → `}
        {figure}
        {` (${kpiChange(r.change, p.changeKind)})`}
      </span>
    );
  }
  return <span className={r.changeUp ? "text-dualis-long" : "text-dualis-short"}>{r.changeUp ? "Better" : "Worse"}</span>;
}

/** One event of a test: when, the candidate's change, the event, and the unbiased price move of the week after. */
function TestRow({ symbol, k, r, arrows, outcome }: { symbol: string; k: GoldKpiDriver; r: KpiEventRow; arrows: Map<string, MoveArrow>; outcome?: React.ReactNode }) {
  const a = r.moveId ? arrows.get(r.moveId) : undefined;
  return (
    <li className="flex flex-col gap-1 border-b border-kumo-hairline py-2.5 text-sm last:border-b-0">
      <span className="flex flex-wrap items-baseline gap-x-3">
        <span className="tabular text-kumo-subtle">{day(r.day)}</span>
        <ChangeWords symbol={symbol} k={k} r={r} />
        {outcome}
      </span>
      {r.kpiWhy && <span className="text-kumo-default"><Rich text={r.kpiWhy} /></span>}
      <span className="text-kumo-default">
        {`${KIND[r.kind]}: `}
        <EventTitle symbol={symbol} e={r} />
      </span>
      <span className="text-kumo-subtle">{`Price ${pct(r.reaction)} beyond the market in the week after · ${a ? `significant move ${a.n}` : "not a significant move"}`}</span>
    </li>
  );
}

const FOLLOWED = { confirms: "Followed", invalidates: "Did not follow" } as const;

/** Step B for one candidate: the AI's sentence on top, then the two tests in closed drawers. */
export function ConfidenceBody({ symbol, k, arrows }: { symbol: string; k: GoldKpiDriver; arrows: MoveArrow[] }) {
  const byId = new Map(arrows.map((a) => [a.id, a]));
  const t = k.tests;
  const changed = k.rows.filter((r) => r.kpiMoved === true);
  const changedIn = new Map<string, KpiEventRow[]>();
  for (const r of changed) if (r.moveId) changedIn.set(r.moveId, [...(changedIn.get(r.moveId) ?? []), r]);
  const explained = new Set(t?.explainedMoveIds ?? []);
  return (
    <div className="flex flex-col gap-4">
      {/* The level itself sits in the drawer's title (never twice). */}
      <div className="flex flex-col gap-2">
        {k.reason && <p className="text-lg leading-snug text-kumo-strong"><Rich text={k.reason} /></p>}
        <p className="text-sm text-kumo-subtle">{`${CANDIDATE_KIND_WORD[k.kind]} · ${measuredWord(k)} · when it goes up, the price should go ${k.expected}`}</p>
      </div>
      {!t ? (
        <p className="text-base text-kumo-subtle">Not tested yet.</p>
      ) : (
        <Drawers>
          <Drawer icon={<TrendUpIcon size={16} aria-hidden />} title={<Title name={`Each big change in ${k.name}: did the stock make a significant move (market removed) the week after?`} conclusion={`${t.followed} of ${t.changes}`} />}>
            <PeriodStrip k={k} />
            {changed.length ? (
              <ul className="flex flex-col">
                {[...changed].reverse().map((r) => (
                  <TestRow key={r.eventId} symbol={symbol} k={k} r={r} arrows={byId} outcome={<Badge variant={r.result === "confirms" ? "success" : "error"}>{FOLLOWED[r.result as keyof typeof FOLLOWED] ?? "Did not follow"}</Badge>} />
                ))}
              </ul>
            ) : (
              <p className="text-base text-kumo-subtle">{`No change of it in ${HISTORY_YEARS} years was big enough to matter.`}</p>
            )}
          </Drawer>
          <Drawer icon={<ArrowsDownUpIcon size={16} aria-hidden />} title={<Title name={`Each significant 1-week stock move (market removed): did ${k.name} change on its first day?`} conclusion={`${t.explained} of ${t.moves}`} />}>
            <WeekStrip arrows={arrows} marked={explained} />
            <ol className="flex flex-col">
              {arrows.map((a) => {
                const rows = changedIn.get(a.id) ?? [];
                return (
                  <li key={a.id} className="grid grid-cols-[2rem_6.5rem_4rem_1fr] items-baseline gap-x-3 border-b border-kumo-hairline py-2 text-sm last:border-b-0">
                    <span className={`font-semibold tabular ${a.direction === "up" ? "text-dualis-long" : "text-dualis-short"}`}>{a.n}</span>
                    <span className="tabular text-kumo-subtle">{day(a.startDay)}</span>
                    <span className={`tabular font-semibold ${a.direction === "up" ? "text-dualis-long" : "text-dualis-short"}`}>{pct(a.abnormal)}</span>
                    {rows.length ? (
                      <span className="flex flex-col gap-0.5 text-kumo-default">
                        {rows.map((r) => (
                          <span key={r.eventId}>
                            <ChangeWords symbol={symbol} k={k} r={r} />
                            {" · "}
                            <EventTitle symbol={symbol} e={r} />
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-kumo-subtle">Did not change</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </Drawer>
        </Drawers>
      )}
    </div>
  );
}

/** « since 20 Nov 2026 · 5 days ago »: how fresh a reading is (Kevin 2026-11-25: fresh, or maybe already priced in). */
function Since({ at }: { at: Date | null | undefined }) {
  if (!at) return null;
  return <span className="text-sm font-normal text-kumo-subtle">{`since ${day(at.toISOString().slice(0, 10))} · ${relativeTime(at)}`}</span>;
}

/** Step D's bottom line as the judge stored it: « Strong BUY », « Weak SELL », « Strong continuation », « Noise », and since when. */
function ReversalBadge({ k, since }: { k: Pick<GoldKpiDriver, "reversal">; since?: Date | null }) {
  const w = reversalWord(k.reversal);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge appearance="dot" variant={w.variant}>
        {w.word}
      </Badge>
      <Since at={since} />
    </span>
  );
}

const CHANCE_WORD: Record<DriverReversal["leading"]["probability"], string> = { high: "High chance it turns soon", medium: "Some chance it turns soon", low: "Low chance it turns soon", none: "No leading indicator" };
const LASTING: Record<string, string> = { structural: "Structural", temporary: "Temporary" };

/** Step D for one Price Driver: the bottom line with whether it lasts, how big and how much is priced in; then its own direction, a leading indicator, the documents. */
export function ReversalBody({ symbol, k }: { symbol: string; k: GoldKpiDriver }) {
  const r = k.reversal;
  if (!trusted(k)) return <p className="text-base text-kumo-subtle">Not a price driver: it is not read against the narrative.</p>;
  if (!r) return <p className="text-base text-kumo-subtle">Not read yet.</p>;
  const m = r.magnitude;
  const cites = r.citations ?? [];
  const lasting = r.durability ? LASTING[r.durability] : undefined;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="text-lg leading-snug text-kumo-strong"><Rich text={r.why} /></p>
        {(lasting || m || r.pricedIn) && (
          <span className="flex flex-wrap items-center gap-2 text-sm text-kumo-subtle">
            {lasting && <Badge variant="outline">{lasting}</Badge>}
            {m && <Badge variant="outline">{`${m.figure}${m.from && m.to ? `: ${m.from} to ${m.to}` : ""}${m.change ? ` (${m.change})` : ""} · ${m.size === "material" ? "Material" : "Small"}`}</Badge>}
            {r.pricedIn && <span>{PRICED_WORD[r.pricedIn]}</span>}
          </span>
        )}
      </div>
      <Drawers>
        <Drawer icon={<GaugeIcon size={16} aria-hidden />} title={<Title name="On its latest value" conclusion={STATE_WORD[r.intrinsic.state]} />}>
          <PeriodStrip k={k} />
          <p className="text-base text-kumo-default">
            {r.intrinsic.period && k.measure ? `${periodWords(k.measure.periodType, r.intrinsic.period)}: ` : ""}
            <Rich text={r.intrinsic.why} />
          </p>
        </Drawer>
        <Drawer icon={<CompassIcon size={16} aria-hidden />} title={<Title name="Leading indicator" conclusion={CHANCE_WORD[r.leading.probability]} />}>
          <p className="text-base text-kumo-default"><Rich text={r.leading.why} /></p>
          {r.leading.events.length > 0 && (
            <ul className="flex flex-col">
              {r.leading.events.map((e) => (
                <li key={e.id} className="border-b border-kumo-hairline py-2 text-sm text-kumo-default last:border-b-0">
                  {`${day(e.day)} · ${KIND[e.kind]}: `}
                  <EventTitle symbol={symbol} e={e} />
                </li>
              ))}
            </ul>
          )}
        </Drawer>
        {cites.length > 0 && (
          <Drawer icon={<FileTextIcon size={16} aria-hidden />} title={<Title name="In the company's words" conclusion={plural(cites.length, "quote")} />}>
            <ul className="flex flex-col gap-2">
              {cites.map((c, i) => (
                <li key={i} className="text-base leading-relaxed text-kumo-default">
                  <Sourced symbol={symbol} item={docItemId(c.documentId, c.page, c.quote)}>{`« ${c.quote} »`}</Sourced>
                </li>
              ))}
            </ul>
          </Drawer>
        )}
      </Drawers>
    </div>
  );
}

const SIDE_WORD = { long: "Pessimistic", short: "Optimistic" } as const;
const CONFIDENCE_WORD = { strong: "strong confidence", weak: "weak confidence", noise: "noise" } as const;
const TURNING_WORD = { strong: "strong", weak: "weak", noise: "noise" } as const;
const held = (n: ProofData["narrative"]) => n?.confidence === "strong" || n?.confidence === "weak";

/** Step C: why the stock sits below or above its fair value and how sure the AI is, then each Price Driver that explains it, under its own name, with what the market believes about it. */
export function NarrativeBody({ symbol, narrative }: { symbol: string; narrative: NonNullable<ProofData["narrative"]> }) {
  return (
    <div className="flex flex-col gap-4">
      {narrative.sideWhy && <p className="text-lg leading-snug text-kumo-strong"><Rich text={narrative.sideWhy} /></p>}
      {narrative.detail && <p className="text-base leading-relaxed text-kumo-default"><Rich text={narrative.detail} /></p>}
      <ol className="flex flex-col">
        {narrative.beliefs.map((d) => (
          <li key={d.id}>
            <Link href={itemHref(symbol, `kdriver:${d.id}`)} scroll={false} className="-mx-3 flex flex-wrap items-baseline gap-x-2 rounded-lg px-3 py-2.5 text-base transition-colors hover:bg-kumo-tint">
              <span className="font-semibold text-kumo-strong">{d.name}</span>
              <span className="text-kumo-subtle">·</span>
              <span className="text-kumo-default"><Rich text={d.belief ?? ""} /></span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Step E: the judge's sentence, the call, and the events behind it (those the leading Price Driver's reversal read). */
export function SignalBody({ symbol, signal, events }: { symbol: string; signal: NonNullable<ProofData["signal"]>; events: GoldDriverEvent[] }) {
  const behind = signal.evidenceIds.map((id) => events.find((e) => e.id === id)).filter((e): e is GoldDriverEvent => !!e);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {signal.signal !== "none" && (
          <Badge variant="secondary" className={`font-semibold tracking-wide ${signal.signal === "BUY" ? "bg-dualis-long-soft text-dualis-long" : "bg-dualis-short-soft text-dualis-short"}`}>
            {signal.signal}
          </Badge>
        )}
        {signal.why && <p className="text-lg leading-snug text-kumo-strong"><Rich text={signal.why} /></p>}
      </div>
      {behind.length > 0 && (
        <ul className="flex flex-col">
          {behind.map((e) => (
            <li key={e.id} className="border-b border-kumo-hairline py-2 text-sm text-kumo-default last:border-b-0">
              {`${day(e.day)} · ${KIND[e.kind]}: `}
              <EventTitle symbol={symbol} e={e} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The panel shows this many events; the Analysis page shows them all (Kevin 2026-11-25). */
export const PANEL_EVENTS = 10;

/** « See all 373 events › »: from the panel to the same list, whole, on the Analysis page. */
function SeeAll({ symbol, anchor, words }: { symbol: string; anchor: string; words: string }) {
  return (
    <Link href={`/tickers/${encodeURIComponent(symbol)}#${anchor}`} className="self-start text-sm font-medium text-kumo-link hover:underline">
      {`${words} ›`}
    </Link>
  );
}

/** « 373 events · 259 industry news, 80 company news, 29 filings, 5 results » (Kevin 2026-11-25: « 373, 259 on its industry » was unclear). */
export function eventCounts(events: Pick<GoldDriverEvent, "kind" | "sourceId">[], industryNews: Set<string>): string {
  const industry = events.filter((e) => e.kind === "news" && industryNews.has(e.sourceId)).length;
  const company = events.filter((e) => e.kind === "news").length - industry;
  const filings = events.filter((e) => e.kind === "filing").length;
  const results = events.filter((e) => e.kind === "release").length;
  const parts = [[industry, "industry news"], [company, "company news"], [filings, "filing", "filings"], [results, "result", "results"]] as const;
  return `${plural(events.length, "event")} · ${parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => (many ? plural(n, one, many) : `${n} ${one}`))
    .join(", ")}`;
}

/** Steps A to E from loaded data (pure: the test renders it). The panel lists the latest events and the Price Drivers only, each with a link to the whole list on the Analysis page. */
export function ProofView({ symbol, data, panel = false }: { symbol: string; data: ProofData; panel?: boolean }) {
  const { events, arrows, kpis, chart, industryNews, narrative, signal, reversalSince } = data;
  const ranked = [...kpis].sort((a, b) => LEVEL_RANK[a.level ?? "none"] - LEVEL_RANK[b.level ?? "none"] || a.rank - b.rank);
  const count = (l: "strong" | "weak") => kpis.filter((k) => k.level === l).length;
  const strong = count("strong");
  const weak = count("weak");
  const pds = ranked.filter(trusted);
  const reversing = pds.filter((k) => turnsAgainst(k.reversal)).sort((a, b) => LEVEL_RANK[a.reversal!.strength] - LEVEL_RANK[b.reversal!.strength]);
  const continuing = pds.filter((k) => k.reversal?.stance === "with");
  const withEvents = arrows.filter((a) => a.events.length > 0).length;
  const stepD = held(narrative);
  const reversals = !pds.length
    ? "No price driver"
    : !narrative
      ? "No narrative to read them against yet"
      : !stepD
        ? `Not read: the narrative is ${narrative.confidence ? CONFIDENCE_WORD[narrative.confidence] : "not read yet"}`
        : reversing.length
          ? reversing.slice(0, 2).map((k) => `${k.name}: ${reversalWord(k.reversal).word}`).join(" · ")
          : continuing.length
            ? `${plural(continuing.length, "price driver")} in continuation, none in reversal`
            : "Noise: no price driver in reversal";
  return (
    <Drawers>
      <Drawer id="step-a" openOn={["events"]} icon={<MagnifyingGlassIcon size={18} aria-hidden />} title={<Title big name="A · Price Driver Candidates" conclusion={`${kpis.length} found`} />}>
        <Drawers>
          <Drawer id="events" icon={<CalendarDotsIcon size={16} aria-hidden />} title={<Title name="Events" conclusion={eventCounts(events, industryNews)} />}>
            <EventsTimeline events={events.map((e) => ({ day: e.day, kind: e.kind, title: decodeEntities(e.title), moved: e.moveId !== null }))} from={chart.price[0]?.date ?? events[0]?.day ?? ""} to={chart.price.at(-1)?.date ?? events.at(-1)?.day ?? ""} />
            <EventList symbol={symbol} events={panel ? events.slice(-PANEL_EVENTS) : events} industry={industryNews} />
            {panel && events.length > PANEL_EVENTS && <SeeAll symbol={symbol} anchor="events" words={`See all ${events.length} events`} />}
          </Drawer>
          <Drawer icon={<ChartBarIcon size={16} aria-hidden />} title={<Title name="Significant unbiased 1-week moves" conclusion={plural(arrows.length, "move")} />}>
            <MovesChart symbol={symbol} price={chart.price} indexName={chart.indexName} arrows={arrows} />
          </Drawer>
          <Drawer icon={<ListChecksIcon size={16} aria-hidden />} title={<Title name="Events of each significant move" conclusion={`${withEvents} of ${plural(arrows.length, "move")} with an event`} />}>
            <WeekStrip arrows={arrows} />
            <WeekEvents symbol={symbol} arrows={arrows} industry={industryNews} />
          </Drawer>
          <Drawer icon={<LightbulbIcon size={16} aria-hidden />} title={<Title name="Candidates read in those events" conclusion={plural(kpis.length, "candidate")} />}>
            {kpis.length ? <CandidateList symbol={symbol} kpis={kpis} /> : <p className="text-base text-kumo-subtle">Not listed yet.</p>}
          </Drawer>
        </Drawers>
      </Drawer>
      <Drawer id="price-drivers" icon={<SealCheckIcon size={18} aria-hidden />} title={<Title big name="B · Price Drivers" conclusion={kpis.length ? `${strong} strong, ${weak} weak, ${kpis.length - strong - weak} noise` : "Not tested yet"} />}>
        {(!panel || pds.length > 0) && (
          <Drawers>
            {(panel ? pds : ranked).map((k) => (
              <Drawer key={k.id} title={<Title name={k.name} conclusion={<ConfidenceBadge level={!k.level || k.level === "none" ? "noise" : k.level} />} />}>
                <ConfidenceBody symbol={symbol} k={k} arrows={arrows} />
              </Drawer>
            ))}
          </Drawers>
        )}
        {panel && kpis.length > pds.length && <SeeAll symbol={symbol} anchor="price-drivers" words={`See ${plural(kpis.length - pds.length, "noise candidate")}`} />}
      </Drawer>
      <Drawer
        icon={<BookOpenTextIcon size={18} aria-hidden />}
        title={
          <Title
            big
            name="C · Narrative"
            conclusion={
              narrative ? (
                <span>
                  <span className="font-semibold">{`${SIDE_WORD[narrative.side]}, ${narrative.confidence ? CONFIDENCE_WORD[narrative.confidence] : "confidence not read yet"}: `}</span>
                  <Rich text={narrative.text} />
                </span>
              ) : pds.length ? (
                "Not written yet"
              ) : (
                "No price driver to write it on"
              )
            }
          />
        }
      >
        {narrative ? <NarrativeBody symbol={symbol} narrative={narrative} /> : <p className="text-base text-kumo-subtle">The narrative is written on the price drivers.</p>}
      </Drawer>
      <Drawer icon={<TrendUpIcon size={18} aria-hidden />} title={<Title big name="D · Reversals" conclusion={reversals} />}>
        {pds.length && stepD ? (
          <Drawers>
            {pds.map((k) => (
              <Drawer key={k.id} title={<Title name={k.name} conclusion={<ReversalBadge k={k} since={reversalSince.get(k.id)} />} />}>
                <ReversalBody symbol={symbol} k={k} />
              </Drawer>
            ))}
          </Drawers>
        ) : (
          <p className="text-base text-kumo-subtle">{pds.length ? "Read only when the narrative is held with weak or strong confidence." : "No candidate earned a strong or weak confidence."}</p>
        )}
      </Drawer>
      <Drawer icon={<SirenIcon size={18} aria-hidden />} title={<Title big name="E · Signal" conclusion={signal && stepD ? (
              <span className="flex flex-wrap items-center gap-2">
                {`Narrative turning: ${TURNING_WORD[signal.strength]}`}
                <Since at={signal.since} />
              </span>
            ) : (
              "Not read yet"
            )} />}>
        {signal && stepD ? <SignalBody symbol={symbol} signal={signal} events={events} /> : <p className="text-base text-kumo-subtle">Read once the narrative and the reversals of its price drivers are.</p>}
      </Drawer>
    </Drawers>
  );
}

/** The Analysis page and the ticker panel: steps A to E, closed. */
export async function ProofSections({ symbol, panel = false }: { symbol: string; panel?: boolean }) {
  const data = await proofData(symbol);
  if (data.events.length === 0 && data.kpis.length === 0) return null;
  return <ProofView symbol={symbol} data={data} panel={panel} />;
}

/** The `kdriver:` panel: that candidate's step B (confidence), then its step D (reversal), closed, each title carrying its conclusion. */
export async function DriverProof({ symbol, k }: { symbol: string; k: GoldKpiDriver }) {
  const { arrows, reversalSince } = await proofData(symbol);
  return (
    <Drawers>
      <Drawer icon={<SealCheckIcon size={16} aria-hidden />} title={<Title name="B · Price Driver" conclusion={<ConfidenceBadge level={!k.level || k.level === "none" ? "noise" : k.level} />} />}>
        <ConfidenceBody symbol={symbol} k={k} arrows={arrows} />
      </Drawer>
      <Drawer icon={<TrendUpIcon size={16} aria-hidden />} title={<Title name="D · Reversal" conclusion={trusted(k) ? <ReversalBadge k={k} since={reversalSince.get(k.id)} /> : "Not a price driver"} />}>
        <ReversalBody symbol={symbol} k={k} />
      </Drawer>
    </Drawers>
  );
}
