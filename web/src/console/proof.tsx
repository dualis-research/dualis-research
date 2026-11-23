import { ArrowsDownUpIcon, CalendarDotsIcon, ChartBarIcon, CompassIcon, CrosshairIcon, GaugeIcon, LightbulbIcon, ListChecksIcon, MagnifyingGlassIcon, ScalesIcon, SealCheckIcon, TrendUpIcon } from "@phosphor-icons/react/ssr";
import { Badge } from "@cloudflare/kumo";
import type { DriverReversal, GoldDriverEvent, GoldKpiDriver, KpiEventRow } from "@/db/schema/analysis";
import { decodeEntities } from "@/collectors/dimensions/content-posts/parse";
import { kpiChange, kpiValue, periodWords } from "@/collectors/dimensions/kpi-drivers/steps";
import { ConfidenceBadge } from "./confidence-badge";
import { docItemId } from "./document-page";
import { Drawer, Drawers } from "./drawer";
import { EventsTimeline } from "./driver-steps-charts";
import { day } from "./format";
import { itemHref } from "./item-href";
import { proofData, type ProofData } from "./kpi-queries";
import Link from "./link";
import { NO_ITEM_EXPLAINS, WEEK_BADGE, WEEK_WORD, type MoveArrow } from "./move-arrows";
import { MovesChart } from "./moves-chart";
import { Rich } from "./rich";
import { Sourced, SourcedFigure, sourceItemId } from "./sourced";

/**
 * The proof structure of a stock's Price Drivers (PROOF-STRUCTURE-1123; Kevin + Thierry's whiteboard of 2026-11-23,
 * Kevin: « tout ce que je vois est vraiment de la merde et hors sujet »): every step of the reasoning in the order they
 * reason, closed by default, each title carrying its conclusion so the page reads closed in seconds.
 * 1 · The search for Price Driver Candidates: (1) price movement, (2) events, (3) which event explains which week,
 *     (4) fundamental or not (ONE verdict per week), (5) the candidates read in the events.
 * 2 · Confidence of each candidate: tests A, B and C, the AI's level on top.
 * 3 · The Price Drivers in reversal: on its own latest value, through a leading indicator, the bottom line.
 * The same blocks render on the Analysis page, in the ticker panel and (2 then 3 of one driver) in the `kdriver:` panel.
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

function WeekBadge({ a }: { a: Pick<MoveArrow, "week"> }) {
  return <Badge variant={WEEK_BADGE[a.week]}>{WEEK_WORD[a.week]}</Badge>;
}

/** The unusual weeks in a row, numbered, coloured by step 4's verdict; `marked` rings the weeks a test points at. */
function WeekStrip({ arrows, marked }: { arrows: MoveArrow[]; marked?: Set<string> }) {
  const fill = { fundamental: "bg-kumo-brand text-white", market: "bg-kumo-tint text-kumo-default", unknown: "bg-transparent text-kumo-subtle ring-1 ring-inset ring-kumo-line" } as const;
  return (
    <figure className="flex flex-col gap-2">
      <ol className="flex flex-wrap gap-1.5">
        {arrows.map((a) => (
          <li key={a.id} title={`${day(a.startDay)}: ${WEEK_WORD[a.week]}`} className={`inline-flex size-8 items-center justify-center rounded-md text-xs font-semibold tabular ${fill[a.week]} ${marked?.has(a.id) ? "outline-2 outline-offset-2 outline-dualis-long" : ""}`}>
            {a.n}
          </li>
        ))}
      </ol>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-kumo-default">
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block size-2.5 rounded-sm bg-kumo-brand" />Fundamental week</li>
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block size-2.5 rounded-sm bg-kumo-tint" />Market week</li>
        <li className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block size-2.5 rounded-sm ring-1 ring-inset ring-kumo-line" />Unknown cause</li>
        {marked && <li className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block size-2.5 rounded-sm outline-2 outline-dualis-long" />The candidate changed in it</li>}
        {arrows[0] && <li className="text-kumo-subtle">{`Unusual weeks numbered in date order, ${day(arrows[0].startDay)} to ${day(arrows.at(-1)!.endDay)}`}</li>}
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

/** Step 3: for each unusual week, the news or filings that explain it (the cause's cites), each opening its source. */
function WeekEvents({ symbol, arrows }: { symbol: string; arrows: MoveArrow[] }) {
  return (
    <ol className="flex flex-col">
      {arrows.map((a) => (
        <li key={a.id} className="grid grid-cols-[2rem_11.5rem_4rem_1fr] items-baseline gap-x-3 border-b border-kumo-hairline py-2 text-sm last:border-b-0">
          <Link href={itemHref(symbol, `move:${a.id}`)} scroll={false} className={`font-semibold tabular ${a.direction === "up" ? "text-dualis-long" : "text-dualis-short"}`}>
            {a.n}
          </Link>
          <span className="tabular text-kumo-subtle">{a.startDay === a.endDay ? day(a.startDay) : `${day(a.startDay)} to ${day(a.endDay)}`}</span>
          <span className={`tabular font-semibold ${a.direction === "up" ? "text-dualis-long" : "text-dualis-short"}`}>{pct(a.abnormal)}</span>
          {a.cites.length && a.week !== "unknown" ? (
            <ul className="flex flex-col gap-0.5 text-kumo-default">
              {a.cites.map((c) => (
                <li key={`${c.kind}:${c.id}`}>
                  {`${day(c.at.slice(0, 10))} · ${c.kind === "filing" ? "Filing" : "News"}: `}
                  {c.url && /^https:\/\//.test(c.url) ? <Sourced symbol={symbol} item={sourceItemId({ l: c.title, d: c.at.slice(0, 10), s: c.sources, u: c.url })}>{decodeEntities(c.title)}</Sourced> : decodeEntities(c.title)}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-kumo-subtle">{NO_ITEM_EXPLAINS}</span>
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
              {`${CANDIDATE_KIND_WORD[k.kind]} · ${measuredWord(k)} · ${k.foundIn.length ? `read in ${plural(k.foundIn.length, "event")} of an unusual week` : "the business model makes it obvious"}`}
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

/** One event of a test: when, the candidate's change, the event, the price that week and step 4's verdict on it. */
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
      <span className="flex flex-wrap items-center gap-2 text-kumo-subtle">
        {`Price ${pct(r.reaction)} beyond the market in 5 trading days`}
        {a ? (
          <>
            {` · week ${a.n}`}
            <WeekBadge a={a} />
          </>
        ) : (
          " · not an unusual week"
        )}
      </span>
    </li>
  );
}

const FOLLOWED = { confirms: "Followed", invalidates: "Did not follow" } as const;

/** Section 2 for one candidate: the AI's level on top, then tests A, B and C in closed drawers. */
export function ConfidenceBody({ symbol, k, arrows }: { symbol: string; k: GoldKpiDriver; arrows: MoveArrow[] }) {
  const byId = new Map(arrows.map((a) => [a.id, a]));
  const t = k.tests;
  const changed = k.rows.filter((r) => r.kpiMoved === true);
  const both = changed.filter((r) => r.priceMoved);
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
          <Drawer icon={<TrendUpIcon size={16} aria-hidden />} title={<Title name="A · Each big change: did the price follow?" conclusion={`${t.followed} of ${t.changes}`} />}>
            <PeriodStrip k={k} />
            {changed.length ? (
              <ul className="flex flex-col">
                {[...changed].reverse().map((r) => (
                  <TestRow key={r.eventId} symbol={symbol} k={k} r={r} arrows={byId} outcome={<Badge variant={r.result === "confirms" ? "success" : "error"}>{FOLLOWED[r.result as keyof typeof FOLLOWED] ?? "Did not follow"}</Badge>} />
                ))}
              </ul>
            ) : (
              <p className="text-base text-kumo-subtle">{`No change of it in 3 years was big enough to matter.`}</p>
            )}
          </Drawer>
          <Drawer icon={<ArrowsDownUpIcon size={16} aria-hidden />} title={<Title name="B · Each unusual week: did it change?" conclusion={`in ${t.explained} of ${plural(t.fundamentalMoves, "fundamental week")}`} />}>
            <WeekStrip arrows={arrows} marked={explained} />
            <ol className="flex flex-col">
              {arrows.map((a) => {
                const rows = changedIn.get(a.id) ?? [];
                return (
                  <li key={a.id} className="grid grid-cols-[2rem_6.5rem_7rem_1fr] items-baseline gap-x-3 border-b border-kumo-hairline py-2 text-sm last:border-b-0">
                    <span className={`font-semibold tabular ${a.direction === "up" ? "text-dualis-long" : "text-dualis-short"}`}>{a.n}</span>
                    <span className="tabular text-kumo-subtle">{day(a.startDay)}</span>
                    <span>
                      <WeekBadge a={a} />
                    </span>
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
          <Drawer icon={<CrosshairIcon size={16} aria-hidden />} title={<Title name="C · Both moved" conclusion={`${t.bothAgree} the expected way, ${t.both - t.bothAgree} the other way`} />}>
            {both.length ? (
              <ul className="flex flex-col">
                {[...both].reverse().map((r) => (
                  <TestRow key={r.eventId} symbol={symbol} k={k} r={r} arrows={byId} outcome={<Badge variant={r.result === "confirms" ? "success" : "error"}>{r.result === "confirms" ? "The expected way" : "The other way"}</Badge>} />
                ))}
              </ul>
            ) : (
              <p className="text-base text-kumo-subtle">It never changed in a fundamental week.</p>
            )}
          </Drawer>
        </Drawers>
      )}
    </div>
  );
}

/** « Strong inflection » / « Weak crack »: a turn the price should follow up is an inflection, down a crack. */
export function reversalWords(k: Pick<GoldKpiDriver, "expected" | "reversal">): { word: string; variant: "success" | "warning" | "neutral" } {
  const r = k.reversal;
  if (!r || r.strength === "none") return { word: "No reversal", variant: "neutral" };
  const priceUp = r.direction === null ? null : (r.direction === "up") === (k.expected === "up");
  const what = priceUp === null ? "reversal" : priceUp ? "inflection" : "crack";
  return { word: `${r.strength === "strong" ? "Strong" : "Weak"} ${what}`, variant: r.strength === "strong" ? "success" : "warning" };
}

function ReversalBadge({ k }: { k: Pick<GoldKpiDriver, "expected" | "reversal"> }) {
  const w = reversalWords(k);
  return (
    <Badge appearance="dot" variant={w.variant}>
      {w.word}
    </Badge>
  );
}

const STATE_WORD: Record<DriverReversal["intrinsic"]["state"], string> = { reversing: "Reversing", continuing: "Continuing", flat: "No change that matters" };
const CHANCE_WORD: Record<DriverReversal["leading"]["probability"], string> = { high: "High chance it turns soon", medium: "Some chance it turns soon", low: "Low chance it turns soon", none: "No leading indicator" };

/** Section 3 for one Price Driver: on its latest value, a leading indicator, then the bottom line. */
export function ReversalBody({ symbol, k }: { symbol: string; k: GoldKpiDriver }) {
  const r = k.reversal;
  if (!trusted(k)) return <p className="text-base text-kumo-subtle">Not a trusted price driver: its reversal is not read.</p>;
  if (!r) return <p className="text-base text-kumo-subtle">Not assessed yet.</p>;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-lg leading-snug text-kumo-strong"><Rich text={r.why} /></p>
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
      </Drawers>
    </div>
  );
}

/** The three sections from loaded data (pure: the test renders it). */
export function ProofView({ symbol, data }: { symbol: string; data: ProofData }) {
  const { events, arrows, kpis, chart, industryNews } = data;
  const ranked = [...kpis].sort((a, b) => LEVEL_RANK[a.level ?? "none"] - LEVEL_RANK[b.level ?? "none"] || a.rank - b.rank);
  const count = (l: "strong" | "weak") => kpis.filter((k) => k.level === l).length;
  const strong = count("strong");
  const weak = count("weak");
  const pds = ranked.filter(trusted);
  const turning = pds.filter((k) => k.reversal && k.reversal.strength !== "none").sort((a, b) => LEVEL_RANK[a.reversal!.strength] - LEVEL_RANK[b.reversal!.strength]);
  const industry = events.filter((e) => e.kind === "news" && industryNews.has(e.sourceId)).length;
  const verdicts = (["fundamental", "market", "unknown"] as const).map((w) => `${arrows.filter((a) => a.week === w).length} ${w}`).join(", ");
  const explained = arrows.filter((a) => a.week !== "unknown" && a.cites.length > 0).length;
  return (
    <Drawers>
      <Drawer icon={<MagnifyingGlassIcon size={18} aria-hidden />} title={<Title big name="1 · Price Driver Candidates" conclusion={`${kpis.length} found`} />}>
        <Drawers>
          <Drawer icon={<ChartBarIcon size={16} aria-hidden />} title={<Title name="1 · Price movement" conclusion={plural(arrows.length, "unusual week")} />}>
            <MovesChart symbol={symbol} price={chart.price} indexName={chart.indexName} arrows={arrows} />
          </Drawer>
          <Drawer icon={<CalendarDotsIcon size={16} aria-hidden />} title={<Title name="2 · Events" conclusion={`${events.length}, ${industry} on its industry`} />}>
            <EventsTimeline events={events.map((e) => ({ day: e.day, kind: e.kind, title: decodeEntities(e.title), moved: e.moveId !== null }))} from={chart.price[0]?.date ?? events[0]?.day ?? ""} to={chart.price.at(-1)?.date ?? events.at(-1)?.day ?? ""} />
            <EventList symbol={symbol} events={events} industry={industryNews} />
          </Drawer>
          <Drawer icon={<ListChecksIcon size={16} aria-hidden />} title={<Title name="3 · Which event explains which week" conclusion={`${explained} of ${plural(arrows.length, "week")}`} />}>
            <WeekStrip arrows={arrows} />
            <WeekEvents symbol={symbol} arrows={arrows} />
          </Drawer>
          <Drawer icon={<ScalesIcon size={16} aria-hidden />} title={<Title name="4 · Fundamental or not" conclusion={verdicts} />}>
            <MovesChart symbol={symbol} price={chart.price} indexName={chart.indexName} arrows={arrows} verdicts />
          </Drawer>
          <Drawer icon={<LightbulbIcon size={16} aria-hidden />} title={<Title name="5 · Price Driver Candidates" conclusion={plural(kpis.length, "candidate")} />}>
            {kpis.length ? <CandidateList symbol={symbol} kpis={kpis} /> : <p className="text-base text-kumo-subtle">Not listed yet.</p>}
          </Drawer>
        </Drawers>
      </Drawer>
      <Drawer icon={<SealCheckIcon size={18} aria-hidden />} title={<Title big name="2 · Confidence" conclusion={kpis.length ? `${strong} strong, ${weak} weak` : "Not tested yet"} />}>
        <Drawers>
          {ranked.map((k) => (
            <Drawer key={k.id} title={<Title name={k.name} conclusion={<ConfidenceBadge level={!k.level || k.level === "none" ? "noise" : k.level} />} />}>
              <ConfidenceBody symbol={symbol} k={k} arrows={arrows} />
            </Drawer>
          ))}
        </Drawers>
      </Drawer>
      <Drawer
        icon={<TrendUpIcon size={18} aria-hidden />}
        title={<Title big name="3 · Reversals" conclusion={turning.length ? turning.slice(0, 2).map((k) => `${k.name}: ${reversalWords(k).word.toLowerCase()}`).join(" · ") : pds.length ? "No price driver is turning" : "No trusted price driver"} />}
      >
        {pds.length ? (
          <Drawers>
            {pds.map((k) => (
              <Drawer key={k.id} title={<Title name={k.name} conclusion={<ReversalBadge k={k} />} />}>
                <ReversalBody symbol={symbol} k={k} />
              </Drawer>
            ))}
          </Drawers>
        ) : (
          <p className="text-base text-kumo-subtle">No candidate earned a strong or weak confidence.</p>
        )}
      </Drawer>
    </Drawers>
  );
}

/** The Analysis page and the ticker panel: the three sections, closed. */
export async function ProofSections({ symbol }: { symbol: string }) {
  const data = await proofData(symbol);
  if (data.events.length === 0 && data.kpis.length === 0) return null;
  return <ProofView symbol={symbol} data={data} />;
}

/** The `kdriver:` panel: that driver's confidence (2), then its reversal (3), closed, each title carrying its conclusion. */
export async function DriverProof({ symbol, k }: { symbol: string; k: GoldKpiDriver }) {
  const { arrows } = await proofData(symbol);
  return (
    <Drawers>
      <Drawer icon={<SealCheckIcon size={16} aria-hidden />} title={<Title name="2 · Confidence" conclusion={<ConfidenceBadge level={!k.level || k.level === "none" ? "noise" : k.level} />} />}>
        <ConfidenceBody symbol={symbol} k={k} arrows={arrows} />
      </Drawer>
      <Drawer icon={<TrendUpIcon size={16} aria-hidden />} title={<Title name="3 · Reversal" conclusion={trusted(k) ? <ReversalBadge k={k} /> : "Not a trusted price driver"} />}>
        <ReversalBody symbol={symbol} k={k} />
      </Drawer>
    </Drawers>
  );
}

