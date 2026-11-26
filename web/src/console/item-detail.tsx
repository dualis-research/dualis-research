import { ArrowSquareOutIcon, ArrowsDownUpIcon, BuildingsIcon, CalculatorIcon, ChartBarIcon, DatabaseIcon, FileTextIcon, FilesIcon, MathOperationsIcon, SlidersHorizontalIcon, TableIcon, TextAlignLeftIcon } from "@phosphor-icons/react/ssr";
import { KTable, KTableBody, KTableCell, KTableHead, KTableHeader, KTableRow } from "@/console/kumo";
import Link from "@/console/link";
import { getPriceMove, getStoryEpisode, getValuation } from "./analysis-queries";
import { CAUSE_WORD } from "./story-chart";
import { ArticleBody } from "./article";
import { MethodsTable, RangeCards, ValuationField } from "./valuation-ui";
import { fairValueDetail, kpiDetail, priceDetail } from "./board-queries";
import { kpiDriver } from "./kpi-queries";
import { DriverProof, EventTitle } from "./proof";
import { itemHref, metricLabel } from "./analysis";
import { DriverExhibit, ExhibitChart } from "./driver-chart";
import { formatUnit } from "./exhibit-format";
import { day, numberFormat, price } from "./format";
import { Drawer, Drawers } from "./drawer";
import { Fact, FactList } from "./ui";
import { OWN_WORK, sourceLabel } from "./source-labels";
import { parseSourceItem, SourcedFigure, type SourcePayload } from "./sourced";
import { documentPageDetail } from "./document-queries";
import { DocumentPageText, docItemId, openAt, parseDocItem } from "./document-page";
import type { PeerRow } from "@/db/schema/valuation";
import { Rich } from "./rich";

/**
 * Level C: the detail of one item of the analysis (`?item=` on the Analysis page): what it says and its chart. Where a
 * figure or quote comes from is one click on it (SOURCES-ONE-CLICK-1123, `sourced.tsx`), never a « Source: » line.
 * Items: `fair-value`, `kdriver:<id>` (a Price Driver Candidate: step B then step D), `kpi:<metric>`, `price`,
 * `valuation:<method>`, `move:<move id>` (a significant unbiased 1-week move and its events), `story:<episode id>` (step F),
 * `doc:<document id>:<page>[:<quote>]` (one page of a company document, the quote highlighted), `src:<payload>` (a data
 * figure's source: series, providers by name, date).
 */

export type ItemView = { title: string; subtitle?: React.ReactNode; body: React.ReactNode };

const external = "inline-flex items-start gap-1.5 text-base font-medium text-kumo-strong hover:text-kumo-link";

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

const signed = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);

/** A significant unbiased 1-week move: the move, then the events whose week it was (what step A reads), each opening its source. */
async function moveItem(symbol: string, id: string): Promise<ItemView | null> {
  const r = await getPriceMove(id);
  if (!r || r.move.symbol !== symbol) return null;
  const { move: m, events } = r;
  const span = m.startDay === m.endDay ? day(m.startDay) : `${day(m.startDay)} to ${day(m.endDay)}`;
  return {
    title: `${m.direction === "up" ? "Rise" : "Fall"} of ${signed(m.returnPct)}`,
    subtitle: span,
    body: (
      <>
        <p className="text-xl leading-snug text-kumo-strong">{`${signed(m.abnormal)} beyond the ${m.bench}, ${Math.abs(m.z).toFixed(1)}x its usual 1-week move.`}</p>
        <Drawers>
          <Drawer icon={<ArrowsDownUpIcon size={16} aria-hidden />} title="The move">
            <FactList>
              <Fact label="Stock">{signed(m.returnPct)}</Fact>
              <Fact label={m.bench}>{signed(m.benchReturn)}</Fact>
              <Fact label="Beyond the market">{`${signed(m.abnormal)}, ${Math.abs(m.z).toFixed(1)}x its usual 1-week move`}</Fact>
              <Fact label="Closes">{`${price(m.closeBefore)} to ${price(m.closeEnd)}${m.currency ? ` ${m.currency}` : ""}`}</Fact>
            </FactList>
          </Drawer>
          <Drawer icon={<FilesIcon size={16} aria-hidden />} title={`Events that week · ${events.length}`}>
            {events.length ? (
              <ul className="flex flex-col">
                {events.map((e) => (
                  <li key={e.id} className="border-b border-kumo-hairline py-2 text-sm text-kumo-default last:border-b-0">
                    {`${day(e.day)} · `}
                    <EventTitle symbol={symbol} e={e} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-base text-kumo-subtle">No event stored that week.</p>
            )}
          </Drawer>
        </Drawers>
      </>
    ),
  };
}

/** Step F: one episode of the story of the stock, its sentence first, then the moves it covers and the events it rests on. */
async function storyItem(symbol: string, id: string): Promise<ItemView | null> {
  const r = await getStoryEpisode(id);
  if (!r || r.episode.symbol !== symbol) return null;
  const { episode: e, moves, events } = r;
  const span = e.startDay === e.endDay ? day(e.startDay) : `${day(e.startDay)} to ${day(e.endDay)}`;
  return {
    title: e.title,
    subtitle: `${span} · ${CAUSE_WORD[e.cause]}`,
    body: (
      <>
        <p className="text-xl leading-snug text-kumo-strong">{e.summary}</p>
        <Drawers>
          <Drawer icon={<ArrowsDownUpIcon size={16} aria-hidden />} title={`The price · ${signed(e.returnPct)}`}>
            <FactList>
              <Fact label="Stock">{signed(e.returnPct)}</Fact>
              <Fact label={e.bench}>{signed(e.benchReturn)}</Fact>
            </FactList>
            <ul className="flex flex-col">
              {moves.map((m) => (
                <li key={m.id} className="border-b border-kumo-hairline py-2 text-sm last:border-b-0">
                  <Link href={itemHref(symbol, `move:${m.id}`)} scroll={false} className="hover:text-kumo-link">
                    {`${m.startDay === m.endDay ? day(m.startDay) : `${day(m.startDay)} to ${day(m.endDay)}`}: ${signed(m.abnormal)} beyond the ${m.bench} ›`}
                  </Link>
                </li>
              ))}
            </ul>
          </Drawer>
          <Drawer icon={<FilesIcon size={16} aria-hidden />} title={`Events behind it · ${events.length}`}>
            {events.length ? (
              <ul className="flex flex-col">
                {events.map((ev) => (
                  <li key={ev.id} className="border-b border-kumo-hairline py-2 text-sm text-kumo-default last:border-b-0">
                    {`${day(ev.day)} · `}
                    <EventTitle symbol={symbol} e={ev} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-base text-kumo-subtle">{e.cause === "macro" ? "The market moved it: no event of the company or its industry." : "No event cited."}</p>
            )}
          </Drawer>
        </Drawers>
      </>
    ),
  };
}

/**
 * A Price Driver Candidate's panel: step B (its two tests and the AI's confidence), then step D (its reading against
 * the narrative), the same blocks as the Analysis page, closed, each title carrying its conclusion.
 */
async function kpiDriverItem(symbol: string, id: string): Promise<ItemView | null> {
  const k = await kpiDriver(id);
  if (!k || k.symbol !== symbol) return null;
  return {
    title: k.name,
    // A trusted one is a Price Driver, the rest stay candidates (Kevin 2026-11-23).
    subtitle: k.level === "strong" || k.level === "weak" ? "Price driver" : "Price driver candidate",
    body: <DriverProof symbol={symbol} k={k} />,
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

export async function itemView(symbol: string, item: string): Promise<ItemView | null> {
  if (item === "price") return priceItem(symbol);
  if (item === "fair-value") return fairValueItem(symbol);
  const [kind, ...rest] = item.split(":");
  const key = rest.join(":");
  if (kind === "kpi") return kpiItem(symbol, key);
  if (kind === "kdriver") return kpiDriverItem(symbol, key);
  if (kind === "valuation") return methodItem(symbol, key);
  if (kind === "move") return moveItem(symbol, key);
  if (kind === "story") return storyItem(symbol, key);
  if (kind === "doc") return docItem(symbol, key);
  if (kind === "src") {
    const p = parseSourceItem(key);
    return p ? sourceItem(p) : null;
  }
  return null;
}
