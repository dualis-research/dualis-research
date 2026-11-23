import { ArrowSquareOutIcon, ArrowsDownUpIcon, CheckCircleIcon, FunnelIcon, MinusCircleIcon, XCircleIcon, BuildingsIcon, CalculatorIcon, ChartBarIcon, ChartLineIcon, ChatTextIcon, CrosshairIcon, DatabaseIcon, FileTextIcon, FilesIcon, GaugeIcon, LightbulbIcon, MathOperationsIcon, NewspaperIcon, SlidersHorizontalIcon, TableIcon, TextAlignLeftIcon, TrendUpIcon } from "@phosphor-icons/react/ssr";
import { KTable, KTableBody, KTableCell, KTableHead, KTableHeader, KTableRow } from "@/console/kumo";
import { Badge } from "@cloudflare/kumo";
import Link from "@/console/link";
import { getPriceMove, getTickerAnalysis, getValuation } from "./analysis-queries";
import { ArticleBody } from "./article";
import { MethodsTable, RangeCards, ValuationField } from "./valuation-ui";
import { confidenceDetail, driverDetail, evidenceDetail, exhibitDetail, fairValueDetail, kpiDetail, priceDetail } from "./board-queries";
import { ConfidenceBadge } from "./confidence-badge";
import { kpiDriver, kpiDriverChart } from "./kpi-queries";
import { KpiDriverChart } from "./kpi-driver-chart";
import { MomentCard } from "./moment-card";
import { decodeEntities } from "@/collectors/dimensions/content-posts/parse";
import { COLOR } from "@/design/tokens";
import { StrengthBadge } from "./board";
import { TagBadge } from "./tag-badge";
import { DriverReason } from "./driver-reason";
import { EvidenceRows, Exhibit, itemHref, metricLabel, PRICED_WORD } from "./analysis";
import { reactionLine } from "@/collectors/dimensions/market-reaction/compute";
import { DriverExhibit, ExhibitChart } from "./driver-chart";
import { formatUnit } from "./exhibit-format";
import { day, numberFormat, price, utc } from "./format";
import { Drawer, Drawers } from "./drawer";
import { Fact, FactList } from "./ui";
import { OWN_WORK, sourceLabel } from "./source-labels";
import { parseSourceItem, SourcedFigure, type SourcePayload } from "./sourced";
import { documentPageDetail } from "./document-queries";
import { DocumentPageText, docItemId, openAt, parseDocItem } from "./document-page";
import type { PeerRow } from "@/db/schema/valuation";
import type { ThesisSide } from "@/db/schema/analysis";
import { Rich } from "./rich";

/**
 * Level C: the detail of one item of the analysis (`?item=` on the Analysis page): what it says and its chart. Where a
 * figure or quote comes from is one click on it (SOURCES-ONE-CLICK-1123, `sourced.tsx`), never a « Source: » line.
 * Items: `fair-value`, `narrative` (its detail + Rationale), `news:<catalyst id>` (= its Evidence id), `driver:<id>`, `exhibit:<id>`, `kpi:<metric>`, `price`, `move:<move id>` (a significant price move and its cause),
 * `doc:<document id>:<page>[:<quote>]` (one page of a company document, the quote highlighted), `src:<payload>` (a data
 * figure's source: series, providers by name, date).
 */

export type ItemView = { title: string; subtitle?: React.ReactNode; body: React.ReactNode };

/** A news verdict's weight: a turn before a continuation before noise, strong before weak. */
const verdictWeight = (v: { effect: string; strength: string } | undefined) => (!v ? -1 : (v.effect === "reversal" ? 10 : v.effect === "continuation" ? 5 : 0) + (v.strength === "strong" ? 2 : v.strength === "weak" ? 1 : 0));

const external = "inline-flex items-start gap-1.5 text-base font-medium text-kumo-strong hover:text-kumo-link";

async function newsItem(symbol: string, id: string): Promise<ItemView | null> {
  const d = await evidenceDetail(symbol, id);
  if (!d) return null;
  const { catalyst: c } = d;
  return {
    title: c.headline,
    subtitle: `${day(c.eventDay)}${c.publisher ? ` · ${c.publisher}` : ""}`,
    body: (
      <>
        {d.evidence?.effect === "too-old" ? (
          // Too old (Kevin 2026-11-06): from before the current story, judged against no driver.
          <div className="flex flex-col gap-2">
            <TagBadge effect="too-old" strength="noise" side={null} />
            {d.evidence.why && <p className="text-base leading-relaxed text-kumo-strong"><Rich text={d.evidence.why} /></p>}
          </div>
        ) : d.evidence ? (
          // Judged against EACH driver (Kevin 2026-11-06): one tag per driver, why, and the sentence it rests on.
          // The verdict that counts most on top, in one sentence; every driver's own verdict in its drawer.
          (() => {
            const judged = d.drivers
              .map((drv) => ({ drv, v: d.evidence!.verdicts.find((x) => x.driverId === drv.id) }))
              .sort((a, b) => verdictWeight(b.v) - verdictWeight(a.v));
            const top = judged[0];
            return (
              <>
                {top?.v && (
                  <div className="flex flex-col gap-3">
                    <span><TagBadge effect={top.v.effect} strength={top.v.strength} side={top.drv.side} /></span>
                    {top.v.why && <p className="text-xl leading-snug text-kumo-strong"><Rich text={top.v.why} /></p>}
                  </div>
                )}
                <Drawers>
                  {judged.map(({ drv, v }) => (
                    <Drawer
                      icon={<CrosshairIcon size={16} aria-hidden />}
                      key={drv.id}
                      title={
                        <span className="flex flex-wrap items-center gap-2">
                          {v ? <TagBadge effect={v.effect} strength={v.strength} side={drv.side} /> : <span className="text-sm text-kumo-subtle">Not judged yet</span>}
                          <span>{drv.title}</span>
                        </span>
                      }
                    >
                      {v?.why && <p className="text-base leading-relaxed text-kumo-default"><Rich text={v.why} /></p>}
                      {v?.citedSentence && v.effect !== "noise" && <blockquote className="rounded-lg bg-kumo-tint px-4 py-3 text-sm leading-relaxed text-kumo-default italic">“{v.citedSentence}”</blockquote>}
                      <span className="flex flex-wrap items-center gap-3 text-sm text-kumo-subtle">
                        {v?.pricedIn && v.effect !== "noise" && <span>{PRICED_WORD[v.pricedIn]}</span>}
                        <Link href={itemHref(symbol, `driver:${drv.id}`)} scroll={false} className="font-medium text-kumo-link hover:underline">
                          Open the driver ›
                        </Link>
                      </span>
                    </Drawer>
                  ))}
                  {d.reaction && d.reaction.closeBefore !== null && (
                    <Drawer icon={<ChartLineIcon size={16} aria-hidden />} title="Price reaction">
                      <p className="text-base leading-relaxed text-kumo-default">{reactionLine(d.reaction)}</p>
                    </Drawer>
                  )}
                </Drawers>
              </>
            );
          })()
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <StrengthBadge strength={d.strength} />
              <span className="text-base text-kumo-default">{c.direction === "contradicts" ? "Cracks the narrative" : "Continues the narrative"}</span>
              <span className="text-sm text-kumo-subtle tabular">judge {Math.round(c.probability * 100)}% sure</span>
            </div>
            {c.reason && <p className="text-lg leading-relaxed text-kumo-strong"><Rich text={c.reason} /></p>}
            {c.evidence && <blockquote className="border-l border-kumo-line pl-4 text-base leading-relaxed text-kumo-default italic">“{c.evidence}”</blockquote>}
          </>
        )}
        <Drawers>
        {d.exhibit && (
          <Drawer icon={<ChartBarIcon size={16} aria-hidden />} title={`Exhibit ${d.exhibit.number}: ${d.exhibit.title}`}>
            <Exhibit symbol={symbol} exhibit={d.exhibit} />
          </Drawer>
        )}
        <Drawer icon={<FileTextIcon size={16} aria-hidden />} title={`Original documents · ${d.articles.length + d.filings.length}`}>
          <ul className="flex flex-col gap-4">
            {d.articles.map((a) => (
              <li key={a.id} className="flex flex-col gap-1">
                <a href={a.url} target="_blank" rel="noreferrer" className={external}>
                  {a.title} <ArrowSquareOutIcon size={14} className="mt-1 shrink-0" aria-label="opens the article" />
                </a>
                <span className="flex flex-wrap items-center gap-2 text-sm text-kumo-subtle">
                  {a.publisher && <span>{a.publisher}</span>}
                  {a.publishedAt && <time title={utc(a.publishedAt)}>{day(a.publishedAt)}</time>}
                </span>
              </li>
            ))}
            {d.filings.map((f) => (
              <li key={f.id} className="flex flex-col gap-1">
                {f.url ? (
                  <a href={f.url} target="_blank" rel="noreferrer" className={external}>
                    {f.title} <ArrowSquareOutIcon size={14} className="mt-1 shrink-0" aria-label="opens the filing" />
                  </a>
                ) : (
                  <span className="text-base font-medium text-kumo-strong">{f.title}</span>
                )}
                <span className="flex flex-wrap items-center gap-2 text-sm text-kumo-subtle">
                  <span>{[f.registry, f.form].filter(Boolean).join(" ")}</span>
                  <time title={utc(f.filedAt)}>{day(f.filedAt)}</time>
                </span>
              </li>
            ))}
          </ul>
        </Drawer>
        </Drawers>
      </>
    ),
  };
}

async function kpiItem(symbol: string, metric: string): Promise<ItemView | null> {
  const rows = await kpiDetail(symbol, metric);
  if (rows.length === 0) return null;
  const annual = rows.filter((r) => r.periodType === "year");
  const series = (annual.some((r) => r.actual !== null) ? annual : rows.filter((r) => r.periodType === "quarter")).filter((r) => r.actual !== null);
  const period = series[0]?.periodType === "year" ? "annual" : "quarterly";
  const fmt = (v: number | null) => (v === null ? "–" : metric === "eps" ? v.toFixed(2) : numberFormat({ notation: "compact", maximumFractionDigits: 1 }).format(v));
  const sources = [...new Set(rows.flatMap((r) => Object.values(r.provenance).flatMap((p) => p.sources)))];
  const currency = rows.find((r) => r.currency)?.currency ?? null;
  // Each figure opens its own source (the providers behind that one value): no source line under the table.
  const FIELD = { low: "Consensus low", mean: "Consensus mean", high: "Consensus high", actual: "Reported" } as const;
  const cell = (r: (typeof rows)[number], field: keyof typeof FIELD) => {
    const v = r[field];
    const tags = r.provenance[field]?.sources ?? [];
    if (v === null || tags.length === 0) return fmt(v);
    const period = `${r.periodType === "year" ? "FY" : "Q"} ${r.periodEnd}`;
    return (
      <SourcedFigure symbol={symbol} source={{ l: `${metricLabel(metric)}, ${FIELD[field].toLowerCase()}`, v: `${fmt(v)}${r.currency ? ` ${r.currency}` : ""}`, d: period, s: tags }}>
        {fmt(v)}
      </SourcedFigure>
    );
  };
  return {
    title: `${metricLabel(metric)} vs consensus`,
    subtitle: currency ? `In ${currency}` : undefined,
    body: (
      <>
        {series.length > 0 && (
          <DriverExhibit
            number={1}
            title={`${metricLabel(metric)}, reported`}
            unit={currency}
            period={period}
            points={series.map((r) => ({ date: `${r.periodEnd}-01`, value: r.actual! }))}
            sources={sources}
            symbol={symbol}
          />
        )}
        <Drawers>
        <Drawer icon={<TableIcon size={16} aria-hidden />} title={`Every period · ${rows.length}`}>
        <div className="overflow-x-auto rounded-lg ring-1 ring-kumo-hairline">
          <KTable>
            <KTableHeader>
              <KTableRow>
                <KTableHead className="pl-4">Period</KTableHead>
                <KTableHead className="text-right">Low</KTableHead>
                <KTableHead className="text-right">Mean</KTableHead>
                <KTableHead className="text-right">High</KTableHead>
                <KTableHead className="pr-4 text-right">Actual</KTableHead>
              </KTableRow>
            </KTableHeader>
            <KTableBody>
              {[...rows].reverse().map((r) => (
                <KTableRow key={`${r.periodType}|${r.periodEnd}`}>
                  <KTableCell className="pl-4 whitespace-nowrap">{`${r.periodType === "year" ? "FY" : "Q"} ${r.periodEnd}`}</KTableCell>
                  <KTableCell className="text-right font-mono tabular">{cell(r, "low")}</KTableCell>
                  <KTableCell className="text-right font-mono tabular">{cell(r, "mean")}</KTableCell>
                  <KTableCell className="text-right font-mono tabular">{cell(r, "high")}</KTableCell>
                  <KTableCell className="pr-4 text-right font-mono tabular text-kumo-strong">{cell(r, "actual")}</KTableCell>
                </KTableRow>
              ))}
            </KTableBody>
          </KTable>
        </div>
        </Drawer>
        </Drawers>
      </>
    ),
  };
}

async function priceItem(symbol: string): Promise<ItemView | null> {
  const bars = await priceDetail(symbol);
  const last = bars.at(-1);
  if (!last) return null;
  const sources = [...new Set(bars.flatMap((b) => b.sources))];
  const disagreements = bars.filter((b) => b.alternatives.length > 0).length;
  return {
    title: "Share price",
    subtitle: `Close of ${day(last.date)}: ${price(last.close)}`,
    body: (
      <>
        <DriverExhibit number={1} title={`${symbol} daily close`} unit={null} period="market" points={bars.map((b) => ({ date: b.date, value: b.close }))} sources={sources} symbol={symbol} />
        {disagreements > 0 && <p className="text-base text-kumo-subtle">{`${disagreements} day${disagreements === 1 ? "" : "s"} where a source's close differs by more than 0.5%.`}</p>}
      </>
    ),
  };
}

const MOVE_KIND: Record<string, string> = { fundamental: "Business fact", macro: "Market-wide", technical: "Trading", unknown: "Cause not found" };
const signed = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);

/** A significant price move (Thierry 2026-11-17): what caused it, in one sentence first, then the move and its sources. */
async function moveItem(symbol: string, id: string): Promise<ItemView | null> {
  const r = await getPriceMove(id);
  if (!r || r.move.symbol !== symbol) return null;
  const { move: m, cause: c } = r;
  const span = m.startDay === m.endDay ? day(m.startDay) : `${day(m.startDay)} to ${day(m.endDay)}`;
  const conclusion = c?.fact
    ? c.fact
    : !c
      ? "Not judged yet: the cause is read at the next analysis run."
      : c.candidates === 0
        ? "No news or filing found around this move."
        : `None of the ${c.candidates} news items and filings around this move explains it.`;
  return {
    title: `${m.direction === "up" ? "Rise" : "Fall"} of ${signed(m.returnPct)}`,
    subtitle: span,
    body: (
      <>
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant={c?.kind === "fundamental" ? "primary" : "outline"}>{MOVE_KIND[c?.kind ?? "unknown"]}</Badge>
          {c?.category && <Badge variant="outline">{c.category}</Badge>}
        </span>
        <p className="text-xl leading-snug text-kumo-strong"><Rich text={conclusion} /></p>
        {c?.metric && (
          <p className="text-base text-kumo-default">
            {c.metric.label}: {c.metric.from ? `${c.metric.from} → ` : ""}
            {c.metric.to}
            {c.metric.change ? ` (${c.metric.change})` : ""}, period ended {c.metric.period}
            {c.lasting && c.lasting !== "n-a" ? ` · ${c.lasting === "structural" ? "Structural" : "Temporary"}` : ""}
          </p>
        )}
        <Drawers>
        <Drawer icon={<ArrowsDownUpIcon size={16} aria-hidden />} title="The move">
        <FactList>
          <Fact label="Stock">{signed(m.returnPct)}</Fact>
          <Fact label="S&P 500">{signed(m.benchReturn)}</Fact>
          <Fact label="Excess move">{`${signed(m.abnormal)}, ${Math.abs(m.z).toFixed(1)} standard deviations`}</Fact>
          <Fact label="Closes">{`${price(m.closeBefore)} to ${price(m.closeEnd)}${m.currency ? ` ${m.currency}` : ""}`}</Fact>
        </FactList>
        <p className="text-sm text-kumo-subtle">Significant = beyond two standard deviations of the stock&apos;s own daily moves, S&amp;P 500 taken out.</p>
        </Drawer>
        {c && c.cites.length > 0 && (
          <Drawer icon={<FilesIcon size={16} aria-hidden />} title={`What it rests on · ${c.cites.length}`}>
            <ul className="flex flex-col gap-4">
              {c.cites.map((x) => (
                <li key={`${x.kind}:${x.id}`} className="flex flex-col gap-1">
                  {x.url ? (
                    <a href={x.url} target="_blank" rel="noreferrer" className={external}>
                      {x.title} <ArrowSquareOutIcon size={14} className="mt-1 shrink-0" aria-label={x.kind === "filing" ? "opens the filing" : "opens the article"} />
                    </a>
                  ) : (
                    <span className="text-base font-medium text-kumo-strong">{x.title}</span>
                  )}
                  <span className="flex flex-wrap items-center gap-2 text-sm text-kumo-subtle">
                    <span>{x.kind === "filing" ? "Filing" : (x.publisher ?? "News")}</span>
                    <time title={utc(new Date(x.at))}>{day(x.at)}</time>
                  </span>
                </li>
              ))}
            </ul>
          </Drawer>
        )}
        </Drawers>
      </>
    ),
  };
}

async function driverItem(symbol: string, id: string): Promise<ItemView | null> {
  const d = await driverDetail(symbol, id);
  if (!d) return null;
  return {
    title: d.driver.title,
    subtitle: d.driver.category,
    body: (
      <>
        {/* The reason first, in one sentence (Kevin 2026-11-17), then what changed with its quotes, then the moves. */}
        <DriverReason state={d.state} side={d.side} moves={d.moves} hrefFor={(item) => itemHref(symbol, item)}>
          <Drawer icon={<LightbulbIcon size={16} aria-hidden />} title="Why the market holds it">
            <p className="text-base leading-relaxed text-kumo-default"><Rich text={d.driver.text} /></p>
          </Drawer>
          {d.exhibits.length > 0 && (
            <Drawer icon={<ChartBarIcon size={16} aria-hidden />} title={`Exhibits · ${d.exhibits.length}`}>
              {d.exhibits.map((x) => (
                <Exhibit key={x.id} symbol={symbol} exhibit={x} />
              ))}
            </Drawer>
          )}
          {d.evidence.length > 0 && (
            <Drawer icon={<NewspaperIcon size={16} aria-hidden />} title={`News · ${d.evidence.length}`}>
              <EvidenceRows symbol={symbol} rows={d.evidence} driverId={d.driver.id} side={d.side} />
            </Drawer>
          )}
        </DriverReason>
      </>
    ),
  };
}

const FIT: Record<string, { mark: string; word: string; tone: string }> = {
  explains: { mark: "✓", word: "Explains", tone: "text-dualis-long" },
  contradicts: { mark: "✗", word: "Contradicts", tone: "text-dualis-short" },
  unrelated: { mark: "–", word: "Unrelated", tone: "text-kumo-subtle" },
};
const figureOf = (m: { label: string; from: string | null; to: string; change: string | null } | null | undefined) => (m ? `${m.label}: ${m.from ? `${m.from} → ` : ""}${m.to}${m.change ? ` (${m.change})` : ""}` : null);

/**
 * Driver Temporal Confidence (Kevin 2026-11-19, « pourquoi cette évaluation est fiable aux yeux d'un expert »): the verdict
 * and its one-sentence reason, the count of later business moves it explains, then drawers: the moves it was found from,
 * every later move tested with ✓ / ✗ and why, and the reason itself.
 */
async function confidenceItem(symbol: string, id: string): Promise<ItemView | null> {
  const d = await confidenceDetail(symbol, id);
  if (!d) return null;
  const c = d.confidence;
  const row = (href: string, on: string, ret: number, fact: string | null, figure: string | null, right?: React.ReactNode) => (
    <li key={href}>
      <Link href={href} scroll={false} className="-mx-3 flex items-start justify-between gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-kumo-tint">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm text-kumo-subtle tabular">
            {day(on)} · {`${ret >= 0 ? "+" : ""}${(ret * 100).toFixed(1)}%`}
          </span>
          <span className="text-base text-kumo-strong"><Rich text={fact ?? "No fact written."} /></span>
          {figure && <span className="text-sm text-kumo-default"><Rich text={figure} /></span>}
        </span>
        {right}
      </Link>
    </li>
  );
  return {
    title: d.driver.title,
    subtitle: `${d.driver.category} · how far it can be trusted`,
    body: (
      <>
        <div className="flex flex-col gap-3">
          {c && (
            <span>
              <ConfidenceBadge level={c.level} />
            </span>
          )}
          <p className="text-xl leading-snug text-kumo-strong"><Rich text={c?.reason ?? "Not tested yet: the next run checks the business moves that followed its origin."} /></p>
          {c && (
            <p className="text-sm text-kumo-subtle">
              Explains {c.explained} of {c.tested} later business {c.tested === 1 ? "move" : "moves"}
              {c.contradicted ? `, ${c.contradicted} against it` : ""}. Market-wide and unexplained moves left out.
            </p>
          )}
        </div>
        <Drawers>
          <Drawer icon={<TrendUpIcon size={16} aria-hidden />} title={`Where it comes from · ${d.origin.length}`}>
            {d.origin.length ? (
              <ul className="flex flex-col">{d.origin.map((m) => row(itemHref(symbol, `move:${m.id}`), m.startDay, m.returnPct, m.cause?.fact ?? null, figureOf(m.cause?.metric)))}</ul>
            ) : (
              <p className="text-base text-kumo-subtle">No past move cites it: it was read from the figures, then tested on every business move.</p>
            )}
          </Drawer>
          {c && (
            <Drawer icon={<TableIcon size={16} aria-hidden />} title={`Later moves tested · ${c.tested}`}>
              {c.rows.length ? (
                <ul className="flex flex-col">
                  {c.rows.map((r) =>
                    row(
                      itemHref(symbol, `move:${r.moveId}`),
                      r.day,
                      r.returnPct,
                      r.fact,
                      [figureOf(r.metric), r.why].filter(Boolean).join(" · ") || null,
                      <span className={`shrink-0 text-sm font-medium ${FIT[r.fit].tone}`}>
                        {FIT[r.fit].mark} {FIT[r.fit].word}
                      </span>,
                    ),
                  )}
                </ul>
              ) : (
                <p className="text-base text-kumo-subtle">No business move came after its origin yet.</p>
              )}
            </Drawer>
          )}
          <Drawer icon={<LightbulbIcon size={16} aria-hidden />} title="Why the market holds it">
            <p className="text-base leading-relaxed text-kumo-default"><Rich text={d.driver.text} /></p>
          </Drawer>
        </Drawers>
      </>
    ),
  };
}


/**
 * A KPI driver (Kevin 2026-11-23): the conclusion first, then the proof as a picture before any word (the KPI over the
 * share price, the market's move taken out, a numbered line per tested moment), then why it is a driver (the moments
 * the price followed it), why it may not be (the moments it moved and the price did not), the moments nothing moved,
 * and how the market's noise is taken out. Each moment opens on its own zoomed chart, then the report's words.
 */
async function kpiDriverItem(symbol: string, id: string): Promise<ItemView | null> {
  const k = await kpiDriver(id);
  if (!k || k.symbol !== symbol) return null;
  const c = await kpiDriverChart(k);
  const pct = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
  const KIND = { release: "Results", news: "News", filing: "Filing" } as const;
  const shift = (d: string, days: number) => new Date(Date.parse(d) + days * 86_400_000).toISOString().slice(0, 10);
  type Marks = typeof c.markers | typeof c.quiet;
  const chart = (props: { from?: string; to?: string; height?: number; markers?: Marks; noKpi?: boolean }) => (
    <KpiDriverChart kpi={props.noKpi ? [] : c.kpi} unit={c.unit} currency={c.currency} kpiLabel={k.name} price={c.price} indexName={c.indexName} markers={props.markers ?? c.markers} from={props.from} to={props.to} height={props.height} />
  );
  const facts = (r: (typeof k.rows)[number]) => (
    <>
      {r.why && <p className="text-base leading-relaxed text-kumo-default"><Rich text={r.why} /></p>}
      {r.cite && (
        <Link href={itemHref(symbol, docItemId(r.cite.documentId, r.cite.page, r.cite.quote))} scroll={false} className="text-base text-kumo-default underline decoration-dotted underline-offset-4 hover:text-kumo-link">
          « {r.cite.quote} »
        </Link>
      )}
    </>
  );
  const moments = (rows: typeof k.rows) =>
    [...rows]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((r) => {
        const n = c.number.get(`${r.step ?? "B1"}:${r.releaseId}`);
        return (
          <Drawer key={`${r.step}:${r.releaseId}`} title={`${n ? `${n}. ` : ""}${day(r.day)} · ${KIND[r.kind ?? "release"]}: ${decodeEntities(r.title)}`}>
            <MomentCard
              kpiName={k.name}
              from={r.from}
              to={r.to}
              change={r.change}
              stock={c.stockMove.get(r.day) ?? null}
              beyond={r.reaction}
              indexName={c.indexName}
              verdict={r.verdict}
              navy={COLOR["brand-chart"].light}
              green={COLOR.long.light}
              red={COLOR.short.light}
              grey="#9aa1ab"
            />
            {facts(r)}
          </Drawer>
        );
      });
  const pros = k.rows.filter((r) => r.verdict === "confirms");
  const cons = k.rows.filter((r) => r.verdict === "invalidates");
  const quiet = k.rows.filter((r) => r.verdict === "neutral");
  return {
    title: k.name,
    subtitle: "Narrative driver",
    body: (
      <>
        <div className="flex flex-col gap-3">
          <span>
            <ConfidenceBadge level={k.level === "none" ? "noise" : k.level} />
          </span>
          <p className="text-lg leading-snug text-kumo-strong"><Rich text={k.reason} /></p>
        </div>
        {chart({})}
        <Drawers>
          <Drawer icon={<CheckCircleIcon size={16} aria-hidden />} title={`Why it drives the stock · ${pros.length}`}>
            {pros.length ? (
              <>
                {chart({ markers: c.markers.filter((x) => x.verdict === "confirms"), height: 260 })}
                <Drawers>{moments(pros)}</Drawers>
              </>
            ) : (
              <p className="text-base text-kumo-subtle">The price never followed it.</p>
            )}
          </Drawer>
          <Drawer icon={<XCircleIcon size={16} aria-hidden />} title={`Why it may not · ${cons.length}`}>
            {cons.length ? (
              <>
                {chart({ markers: c.markers.filter((x) => x.verdict === "invalidates"), height: 260 })}
                <Drawers>{moments(cons)}</Drawers>
              </>
            ) : (
              <p className="text-base text-kumo-subtle">It never moved without the price following.</p>
            )}
          </Drawer>
          <Drawer icon={<MinusCircleIcon size={16} aria-hidden />} title={`Moments with no change · ${quiet.length}`}>
            {quiet.length > 0 && chart({ markers: c.quiet, height: 260 })}
            <ul className="flex flex-col">
              {[...quiet].reverse().map((r) => (
                <li key={`${r.step}:${r.releaseId}`} className="border-b border-kumo-hairline py-2 text-sm text-kumo-default last:border-b-0">
                  {day(r.day)} · {KIND[r.kind ?? "release"]}: {decodeEntities(r.title)} · price {pct(r.reaction)} beyond the market
                </li>
              ))}
            </ul>
          </Drawer>
          <Drawer icon={<FunnelIcon size={16} aria-hidden />} title="How the market's noise is taken out">
            {chart({ markers: [], noKpi: true, height: 200 })}
            <p className="text-base leading-relaxed text-kumo-default">
              Each move is the share price over the 5 trading days after the moment, minus {c.beta.toFixed(2)} times the {c.indexName} over the same days. {c.beta.toFixed(2)} is how much this stock usually moves with its market, measured over the year before. The dark line on the chart is the price with that market move taken out.
            </p>
            <p className="text-base text-kumo-default">{k.approximation ? `${k.name} is not reported: approximated as ${k.approximation}.` : `${k.name} is a reported figure.`}</p>
          </Drawer>
        </Drawers>
      </>
    ),
  };
}

async function exhibitItem(symbol: string, id: string): Promise<ItemView | null> {
  const d = await exhibitDetail(symbol, id);
  if (!d) return null;
  const x = d.exhibit;
  return {
    title: `Exhibit ${x.number}: ${x.title}`,
    subtitle: d.driver ? `${d.driver.category}: ${d.driver.title}` : undefined,
    body: (
      <>
        <ExhibitChart number={x.number} title={x.title} chart={x.chart} series={x.series} points={x.points} sources={x.sources} height={280} symbol={symbol} />
        <p className="text-lg leading-relaxed text-kumo-strong"><Rich text={x.takeaway} /></p>
        <Drawers>
        <Drawer icon={<TableIcon size={16} aria-hidden />} title={`Data · ${x.points.length} periods`}>
        <div className="overflow-x-auto rounded-lg ring-1 ring-kumo-hairline">
          <KTable>
            <KTableHeader>
              <KTableRow>
                <KTableHead className="pl-4">Period</KTableHead>
                {x.series.map((s) => (
                  <KTableHead key={s.key} className="pr-4 text-right">
                    {s.label}
                  </KTableHead>
                ))}
              </KTableRow>
            </KTableHeader>
            <KTableBody>
              {[...x.points].reverse().map((p) => (
                <KTableRow key={p.period}>
                  <KTableCell className="pl-4 whitespace-nowrap">{p.period}</KTableCell>
                  {x.series.map((s) => {
                    const v = p.values[s.key];
                    const shown = v === null || v === undefined ? null : formatUnit(v, s.unit, s.currency);
                    const tags = s.sources.length ? s.sources : x.sources;
                    return (
                      <KTableCell key={s.key} className="pr-4 text-right font-mono tabular">
                        {shown === null ? "–" : tags.length ? <SourcedFigure symbol={symbol} source={{ l: s.label, v: shown, d: p.period, s: tags }}>{shown}</SourcedFigure> : shown}
                      </KTableCell>
                    );
                  })}
                </KTableRow>
              ))}
            </KTableBody>
          </KTable>
        </div>
        </Drawer>
        </Drawers>
      </>
    ),
  };
}

/** The Fair Value (level C): the range, the football field, every method (each opens its own panel), the Valuation Report. */
async function fairValueItem(symbol: string): Promise<ItemView | null> {
  const [f, v] = await Promise.all([fairValueDetail(symbol), getValuation(symbol)]);
  if (!f) return null;
  const r = v.report;
  return {
    title: `Fair value ${price(f.value)}${f.currency ? ` ${f.currency}` : ""}`,
    subtitle: r?.label ?? f.label ?? "Weighted from several valuation methods",
    body: (
      <>
        {r && <RangeCards low={r.low} base={r.base} high={r.high} currency={r.currency} baseLabel="Fair value" />}
        {f.conversion && (
          <p className="text-base text-kumo-default">
            Valued in {f.conversion.from} from the company&apos;s statements: {price(f.conversion.value)} {f.conversion.from}, shown in {f.conversion.to} at{" "}
            <SourcedFigure symbol={symbol} source={{ l: `${f.conversion.to} per ${f.conversion.from}`, v: f.conversion.rate.toFixed(4), d: f.conversion.date, s: f.conversion.source.split(", ") }}>
              {f.conversion.rate.toFixed(4)} {f.conversion.to} per {f.conversion.from}
            </SourcedFigure>{" "}
            ({f.conversion.date}).
          </p>
        )}
        <Drawers>
          {r && (
            <Drawer icon={<TextAlignLeftIcon size={16} aria-hidden />} title="Why this value">
              <p className="text-base leading-relaxed text-kumo-default"><Rich text={r.summary} /></p>
            </Drawer>
          )}
          {v.methods.length > 0 && (
            <Drawer icon={<CalculatorIcon size={16} aria-hidden />} title={`Methods · ${v.methods.length}`}>
              <ValuationField v={v} />
              <MethodsTable symbol={symbol} v={v} />
            </Drawer>
          )}
          {r && (
            <Drawer icon={<FileTextIcon size={16} aria-hidden />} title="Valuation report">
              <article className="flex max-w-3xl flex-col gap-4">
                <ArticleBody markdown={r.markdown} />
              </article>
            </Drawer>
          )}
        </Drawers>
      </>
    ),
  };
}

/** The peer multiple a method's table shows: the one it priced off, else its own family's. */
function peerColumn(method: string, multiple: string | undefined): { label: string; read: (p: PeerRow) => number | null | undefined } {
  const id = multiple ?? (method === "pb" ? "pb" : method === "pe" ? "pe" : "ev-ebitda");
  if (id === "pb") return { label: "P/B", read: (p) => p.pb };
  if (id === "pe-forward") return { label: "Forward P/E", read: (p) => p.peForward };
  if (id === "pe") return { label: "P/E", read: (p) => p.pe };
  return { label: "EV/EBITDA", read: (p) => p.evEbitda };
}
const premium = (x: number) => (Math.abs(x) < 0.005 ? "at the median" : `${Math.round(Math.abs(x) * 100)}% ${x > 0 ? "premium" : "discount"}`);
const ratio = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${(x * 100).toFixed(1)}%`);
const compact = (x: number) => numberFormat({ notation: "compact", maximumFractionDigits: 1 }).format(x);

/** One Valuation Method on the ticker (level C): its range, assumptions with why, the calculation step by step, its chart, inputs and report. */
async function methodItem(symbol: string, method: string): Promise<ItemView | null> {
  const v = await getValuation(symbol);
  const m = v.methods.find((x) => x.method === method);
  if (!m) return null;
  const unit = (u: string, x: number) => formatUnit(x, u as "currency", u === "per-share" || u === "currency" ? m.currency : null);
  return {
    title: m.name,
    subtitle: m.family,
    body: (
      <>
        {m.applicable && m.base !== null ? (
          <RangeCards low={m.low} base={m.base} high={m.high} currency={m.currency} baseLabel={`Base${m.weight ? `, weight ${Math.round(m.weight.weight * 100)}%` : ""}`} />
        ) : (
          <p className="text-lg text-kumo-subtle">Not used for this company: <Rich text={m.reason} /></p>
        )}
        <Drawers>
        {(m.summary || m.weight?.why) && (
          <Drawer icon={<TextAlignLeftIcon size={16} aria-hidden />} title="Summary">
            {m.summary && <p className="text-base leading-relaxed text-kumo-default"><Rich text={m.summary} /></p>}
            {m.weight?.why && <p className="text-base text-kumo-default">Weight: <Rich text={m.weight.why} /></p>}
          </Drawer>
        )}
        {m.history && m.history.points.length > 1 && (
          <Drawer icon={<ChartBarIcon size={16} aria-hidden />} title="History">
          <ExhibitChart
            number={1}
            title={m.history.label}
            chart="bar"
            series={[{ key: "h", label: m.history.label, unit: m.history.unit as "multiple", currency: m.currency, sources: [] }]}
            points={m.history.points.map((p) => ({ period: p.period, values: { h: p.value } }))}
            sources={[...new Set(m.inputs.flatMap((i) => i.sources))]}
            symbol={symbol}
          />
          </Drawer>
        )}
        {m.assumptions.length > 0 && (
          <Drawer icon={<SlidersHorizontalIcon size={16} aria-hidden />} title={`Assumptions · ${m.assumptions.length}`}>
            <div className="overflow-x-auto rounded-lg ring-1 ring-kumo-hairline">
              <KTable>
                <KTableHeader>
                  <KTableRow>
                    <KTableHead className="pl-4">Assumption</KTableHead>
                    <KTableHead className="text-right">Low</KTableHead>
                    <KTableHead className="text-right">Base</KTableHead>
                    <KTableHead className="text-right">High</KTableHead>
                    <KTableHead className="pr-4">Why</KTableHead>
                  </KTableRow>
                </KTableHeader>
                <KTableBody>
                  {m.assumptions.map((a) => (
                    <KTableRow key={a.key}>
                      <KTableCell className="pl-4 align-top">{a.label}</KTableCell>
                      <KTableCell className="text-right align-top font-mono tabular">{unit(a.unit, a.low)}</KTableCell>
                      <KTableCell className="text-right align-top font-mono tabular text-kumo-strong">{unit(a.unit, a.base)}</KTableCell>
                      <KTableCell className="text-right align-top font-mono tabular">{unit(a.unit, a.high)}</KTableCell>
                      <KTableCell className="pr-4 align-top text-kumo-default"><Rich text={a.why} /></KTableCell>
                    </KTableRow>
                  ))}
                </KTableBody>
              </KTable>
            </div>
            {m.basis && <p className="text-sm text-kumo-subtle">Run on: {m.basis}</p>}
          </Drawer>
        )}
        {m.steps.length > 0 && (
          <Drawer icon={<MathOperationsIcon size={16} aria-hidden />} title="Calculation">
            <div className="overflow-x-auto rounded-lg ring-1 ring-kumo-hairline">
              <KTable>
                <KTableHeader>
                  <KTableRow>
                    <KTableHead className="pl-4">Step</KTableHead>
                    <KTableHead className="text-right">Low</KTableHead>
                    <KTableHead className="text-right">Base</KTableHead>
                    <KTableHead className="pr-4 text-right">High</KTableHead>
                  </KTableRow>
                </KTableHeader>
                <KTableBody>
                  {m.steps.map((st) => (
                    <KTableRow key={st.label}>
                      <KTableCell className="pl-4">{st.label}</KTableCell>
                      <KTableCell className="text-right font-mono tabular">{unit(st.unit, st.low)}</KTableCell>
                      <KTableCell className="text-right font-mono tabular text-kumo-strong">{unit(st.unit, st.base)}</KTableCell>
                      <KTableCell className="pr-4 text-right font-mono tabular">{unit(st.unit, st.high)}</KTableCell>
                    </KTableRow>
                  ))}
                </KTableBody>
              </KTable>
            </div>
          </Drawer>
        )}
        {m.peers.length > 0 && (
          <Drawer icon={<BuildingsIcon size={16} aria-hidden />} title={`Listed peers · ${m.peers.length}`}>
            {m.peerPricing && (
              <p className="text-base text-kumo-default">
                Base and high start from the peers&apos; median {m.peerPricing.label} of <span className="font-mono tabular">{m.peerPricing.median.toFixed(1)}x</span> ({m.peerPricing.count} {m.peerPricing.count === 1 ? "company" : "companies"}): base{" "}
                <span className="font-mono tabular">{premium(m.peerPricing.premium.base)}</span>, high <span className="font-mono tabular">{premium(m.peerPricing.premium.high)}</span>. The low case stays on the company&apos;s own history.
                {m.peerPricing.why && <span className="mt-2 block text-kumo-strong"><Rich text={m.peerPricing.why} /></span>}
              </p>
            )}
            <div className="overflow-x-auto rounded-lg ring-1 ring-kumo-hairline">
              <KTable>
                <KTableHeader>
                  <KTableRow>
                    <KTableHead className="pl-4">Company</KTableHead>
                    <KTableHead className="text-right">{peerColumn(m.method, m.peerPricing?.multiple).label}</KTableHead>
                    <KTableHead className="text-right">Market cap</KTableHead>
                    <KTableHead className="text-right">Revenue growth</KTableHead>
                    <KTableHead className="pr-4 text-right">EBITDA margin</KTableHead>
                  </KTableRow>
                </KTableHeader>
                <KTableBody>
                  {m.peers.map((p) => {
                    const x = peerColumn(m.method, m.peerPricing?.multiple).read(p);
                    return (
                      <KTableRow key={p.symbol}>
                        <KTableCell className="pl-4">
                          {p.name ?? p.symbol} <span className="font-mono text-[12px] text-kumo-subtle">{p.symbol}</span>
                        </KTableCell>
                        <KTableCell className="text-right font-mono tabular">{x === null || x === undefined ? "–" : `${x.toFixed(1)}x`}</KTableCell>
                        <KTableCell className="text-right font-mono tabular">{p.marketCap ? `${compact(p.marketCap)}${p.currency ? ` ${p.currency}` : ""}` : "–"}</KTableCell>
                        <KTableCell className="text-right font-mono tabular">{ratio(p.revenueGrowth)}</KTableCell>
                        <KTableCell className="pr-4 text-right font-mono tabular">{ratio(p.ebitdaMargin)}</KTableCell>
                      </KTableRow>
                    );
                  })}
                </KTableBody>
              </KTable>
            </div>
          </Drawer>
        )}
        {m.inputs.length > 0 && (
          <Drawer icon={<DatabaseIcon size={16} aria-hidden />} title={`Inputs · ${m.inputs.length}`}>
            <div className="rounded-lg ring-1 ring-kumo-hairline">
              <FactList>
                {m.inputs.map((i) => (
                  <Fact key={i.key} label={i.label}>
                    <span className="flex flex-wrap items-center gap-2">
                      {i.reported === false || i.sources.length === 0 ? (
                        <span className="font-mono tabular">{i.reported === false ? "None reported" : unit(i.unit, i.value)}</span>
                      ) : (
                        <SourcedFigure symbol={symbol} className="font-mono tabular" source={{ l: i.label, v: unit(i.unit, i.value), d: i.period, s: i.sources }}>
                          {unit(i.unit, i.value)}
                        </SourcedFigure>
                      )}
                      <span className="text-sm text-kumo-subtle">{i.period}</span>
                    </span>
                  </Fact>
                ))}
              </FactList>
            </div>
          </Drawer>
        )}
        {m.report && (
          <Drawer icon={<FileTextIcon size={16} aria-hidden />} title="Report">
            <article className="flex max-w-3xl flex-col gap-4">
              <ArticleBody markdown={m.report} />
            </article>
          </Drawer>
        )}
        </Drawers>
      </>
    ),
  };
}

/**
 * A claim's first sentence, whole, as its drawer title; the rest of the claim opens under it. No split when the text
 * is one sentence, or when the first stop is an abbreviation (« U.S. »).
 */
export function leadSentence(text: string): { lead: string; rest: string } {
  const m = /^(.{25,}?[.!?])\s+(?=[A-Z0-9])/.exec(text);
  if (!m || /\b[A-Z]\.$/.test(m[1])) return { lead: text, rest: "" };
  return { lead: m[1], rest: text.slice(m[0].length) };
}

/**
 * Why the market tells this story (Kevin 2026-11-18: the intro and the Rationale told the same thing twice, everything
 * was open at once): the narrative is the panel's subtitle; under it only drawers: where the story stands now, the
 * rationale in short, then one drawer per claim (its first sentence as the title, its drivers and sources inside).
 */
async function narrativeItem(symbol: string, thesis: ThesisSide | null): Promise<ItemView | null> {
  const a = await getTickerAnalysis(symbol, thesis);
  if (!a.narrative) return null;
  const r = a.rationale;
  const st = a.narrativeState;
  const driverByRank = new Map(a.drivers.map((d) => [d.rank, d]));
  const exhibitByNumber = new Map([...a.drivers.flatMap((d) => d.exhibits), ...(r?.exhibits ?? [])].map((x) => [String(x.number), x]));
  const short = r?.summary ?? a.narrative.detail;
  return {
    title: "Why the market tells this story",
    subtitle: <Rich text={a.narrative.text} />,
    body: (
      <>
        <Drawers>
          {st && a.side && (
            <Drawer
              icon={<GaugeIcon size={16} aria-hidden />}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span>Where it stands</span>
                  <TagBadge effect={st.effect} strength={st.strength} side={a.side} />
                </span>
              }
            >
              {st.why && <p className="text-base leading-relaxed text-kumo-default"><Rich text={st.why} /></p>}
              <span className="flex flex-wrap items-center gap-3 text-sm text-kumo-subtle">
                {st.since && st.effect !== "noise" && <span className="tabular">Since {day(st.since)}</span>}
                {st.pricedIn && st.effect !== "noise" && <span>{PRICED_WORD[st.pricedIn]}</span>}
              </span>
            </Drawer>
          )}
          {short && (
            <Drawer icon={<TextAlignLeftIcon size={16} aria-hidden />} title="In short">
              <p className="text-base leading-relaxed text-kumo-default"><Rich text={short} /></p>
            </Drawer>
          )}
          {(r?.claims ?? []).map((c, i) => {
            const { lead, rest } = leadSentence(c.text);
            return (
              <Drawer icon={<ChatTextIcon size={16} aria-hidden />} key={i} title={<Rich text={lead} />}>
                {rest && <p className="text-base leading-relaxed text-kumo-default"><Rich text={rest} /></p>}
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  {c.drivers.map((rank) => {
                    const d = driverByRank.get(rank);
                    return d ? (
                      <Link key={rank} href={itemHref(symbol, `driver:${d.id}`)} scroll={false} className="text-kumo-link hover:underline">
                        {d.title} ›
                      </Link>
                    ) : null;
                  })}
                  {c.sources.map((src, j) => {
                    const x = src.type === "exhibit" ? exhibitByNumber.get(src.ref) : undefined;
                    return x ? (
                      <Link key={j} href={itemHref(symbol, `exhibit:${x.id}`)} scroll={false} className="text-kumo-link hover:underline">
                        Exhibit {x.number}
                      </Link>
                    ) : (
                      <span key={j} className="text-kumo-subtle">
                        {src.label}
                      </span>
                    );
                  })}
                </span>
              </Drawer>
            );
          })}
          {(r?.exhibits ?? []).length > 0 && (
            <Drawer icon={<ChartBarIcon size={16} aria-hidden />} title={`Exhibits · ${r!.exhibits.length}`}>
              {r!.exhibits.map((x) => (
                <Exhibit key={x.id} symbol={symbol} exhibit={x} />
              ))}
            </Drawer>
          )}
        </Drawers>
      </>
    ),
  };
}

/** One page of a company document as printed: the quoted passage highlighted, the pages around it, and the document itself. */
async function docItem(symbol: string, key: string): Promise<ItemView | null> {
  const ref = parseDocItem(key);
  if (!ref) return null;
  const d = await documentPageDetail(symbol, ref.documentId, ref.page);
  if (!d) return null;
  const { document: doc } = d;
  const pageLink = (page: number, label: string) => (
    <Link href={itemHref(symbol, docItemId(doc.id, page))} scroll={false} className="text-kumo-link hover:underline">
      {label}
    </Link>
  );
  return {
    title: doc.title,
    subtitle: `${d.company} · ${day(doc.filedAt)} · Page ${d.page} of ${doc.pageCount}`,
    body: (
      <>
        <DocumentPageText text={d.text} quote={ref.quote} />
        <div className="flex flex-wrap items-center justify-between gap-4 text-sm">
          <span className="flex items-center gap-4">
            {d.page > 1 && pageLink(d.page - 1, `‹ Page ${d.page - 1}`)}
            {d.page < doc.pageCount && pageLink(d.page + 1, `Page ${d.page + 1} ›`)}
          </span>
          {doc.viewUrl && (
            <a href={openAt(doc.viewUrl, doc.format, d.page)} target="_blank" rel="noreferrer" className={external}>
              Open document <ArrowSquareOutIcon size={14} className="mt-1 shrink-0" aria-label="opens the document" />
            </a>
          )}
        </div>
      </>
    ),
  };
}

/**
 * A data figure's source (`src:<payload>`, SOURCES-ONE-CLICK-1123): the figure as printed, then what it is, when, and
 * who publishes it, providers by name (« Yahoo Finance », « Company filings (DART) »), never a table or layer name.
 */
function sourceItem(payload: SourcePayload): ItemView {
  const from = [...new Set(payload.s.map(sourceLabel))];
  const rank = (l: string) => (l.startsWith("Company filings") ? 0 : l === OWN_WORK ? 2 : 1);
  from.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return {
    title: payload.l,
    subtitle: payload.d,
    body: (
      <>
        {payload.v && <p className="font-mono text-3xl tabular text-kumo-strong">{payload.v}</p>}
        <div className="rounded-lg ring-1 ring-kumo-hairline">
          <FactList>
            <Fact label={from.length > 1 ? "Sources" : "Source"}>{from.length ? from.join(", ") : "Not recorded"}</Fact>
          </FactList>
        </div>
        {payload.u && (
          <a href={payload.u} target="_blank" rel="noreferrer" className={external}>
            Open the original <ArrowSquareOutIcon size={14} className="mt-1 shrink-0" aria-label="opens the original" />
          </a>
        )}
      </>
    ),
  };
}

export async function itemView(symbol: string, item: string, thesis: ThesisSide | null = null): Promise<ItemView | null> {
  if (item === "price") return priceItem(symbol);
  if (item === "fair-value") return fairValueItem(symbol);
  if (item === "narrative") return narrativeItem(symbol, thesis);
  const [kind, ...rest] = item.split(":");
  const key = rest.join(":");
  if (kind === "news") return newsItem(symbol, key);
  if (kind === "kpi") return kpiItem(symbol, key);
  if (kind === "driver") return driverItem(symbol, key);
  if (kind === "confidence") return confidenceItem(symbol, key);
  if (kind === "kdriver") return kpiDriverItem(symbol, key);
  if (kind === "exhibit") return exhibitItem(symbol, key);
  if (kind === "valuation") return methodItem(symbol, key);
  if (kind === "move") return moveItem(symbol, key);
  if (kind === "doc") return docItem(symbol, key);
  if (kind === "src") {
    const p = parseSourceItem(key);
    return p ? sourceItem(p) : null;
  }
  return null;
}
