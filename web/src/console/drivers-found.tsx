import { ArrowsDownUpIcon, CalendarDotsIcon, CaretRightIcon } from "@phosphor-icons/react/ssr";
import type { GoldDriverEvent, GoldKpiDriver, GoldPriceMove } from "@/db/schema/analysis";
import { decodeEntities } from "@/collectors/dimensions/content-posts/parse";
import { ConfidenceBadge } from "./confidence-badge";
import { docItemId } from "./document-page";
import { Drawer, Drawers } from "./drawer";
import { EventsTimeline } from "./driver-steps-charts";
import { day } from "./format";
import { itemHref } from "./item-href";
import { KpiDriverChart } from "./kpi-driver-chart";
import { driverFindings } from "./kpi-queries";
import Link from "./link";
import { Sourced, sourceItemId } from "./sourced";
import { Section } from "./signal";

/**
 * « How the drivers were found » (DRIVERS-SIX-STEPS-1123, Kevin 2026-11-23: « visible en étapes, sections, aux bons
 * endroits, pour qu'un humain puisse voir tout de suite s'il y a une erreur »): steps 1 to 3 on the Analysis page,
 * each opening on its picture, the detail in closed drawers. Steps 4 to 6 live in each KPI's panel (`kdriver:`).
 */

const KIND = { release: "Results", news: "News", filing: "Filing" } as const;
const signed = (x: number | null) => (x === null ? "–" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const times = (z: number | null) => (z === null ? "" : `${Math.abs(z).toFixed(1)}x its usual move`);

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="flex items-center gap-3 text-lg font-semibold text-kumo-strong">
        <span className="inline-flex size-7 items-center justify-center rounded-full bg-kumo-tint font-mono text-sm text-kumo-default">{n}</span>
        {title}
      </h3>
      {children}
    </div>
  );
}

/** An event's title, one click on it opens its source: the report's pages for a release, else the publisher's or registry's page. */
export function EventTitle({ symbol, e }: { symbol: string; e: Pick<GoldDriverEvent, "kind" | "sourceId" | "title" | "day" | "url"> }) {
  const title = decodeEntities(e.title.replace(/\s+/g, " "));
  if (e.kind === "release") return <Sourced symbol={symbol} item={docItemId(e.sourceId, 1)}>{title}</Sourced>;
  if (e.url && /^https:\/\//.test(e.url)) return <Sourced symbol={symbol} item={sourceItemId({ l: title, d: e.day, s: [], u: e.url })}>{title}</Sourced>;
  return <>{title}</>;
}

function EventList({ symbol, events }: { symbol: string; events: GoldDriverEvent[] }) {
  return (
    <ul className="flex flex-col">
      {[...events].reverse().map((e) => (
        <li key={e.id} className="grid grid-cols-[6.5rem_4.5rem_1fr] gap-3 border-b border-kumo-hairline py-2 text-sm last:border-b-0">
          <span className="tabular text-kumo-subtle">{day(e.day)}</span>
          <span className="text-kumo-subtle">{KIND[e.kind]}</span>
          <span className="min-w-0 text-kumo-default">
            <EventTitle symbol={symbol} e={e} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function WeekList({ symbol, moves, events }: { symbol: string; moves: GoldPriceMove[]; events: GoldDriverEvent[] }) {
  return (
    <ul className="flex flex-col">
      {[...moves].reverse().map((m) => {
        const own = events.filter((e) => e.moveId === m.id);
        return (
          <li key={m.id} className="flex flex-col gap-1 border-b border-kumo-hairline py-3 last:border-b-0">
            <span className="flex flex-wrap items-baseline gap-x-3 text-sm">
              <span className="tabular text-kumo-subtle">{`${day(m.startDay)} to ${day(m.endDay)}`}</span>
              <span className={`font-semibold tabular ${m.direction === "up" ? "text-dualis-long" : "text-dualis-short"}`}>{`${signed(m.abnormal)} beyond the ${m.bench}`}</span>
              <span className="text-kumo-subtle">{times(m.z)}</span>
            </span>
            {own.length ? (
              <ul className="flex flex-col gap-0.5 text-sm text-kumo-default">
                {own.map((e) => (
                  <li key={e.id}>
                    {`${KIND[e.kind]}: `}
                    <EventTitle symbol={symbol} e={e} />
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-sm text-kumo-subtle">No known cause</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** How a candidate's kind reads on screen (meeting 2026-11-23: a KPI, a policy, or a qualitative industry fact). */
export const CANDIDATE_KIND_WORD = { kpi: "KPI", policy: "Policy", industry: "Industry" } as const;

const measured = (k: GoldKpiDriver) => k.measure?.label ?? "Not measured: no stored figure, none printed in the reports";

function CandidateList({ symbol, kpis }: { symbol: string; kpis: GoldKpiDriver[] }) {
  return (
    <ol className="flex flex-col">
      {kpis.map((k) => (
        <li key={k.id}>
          <Link href={itemHref(symbol, `kdriver:${k.id}`)} scroll={false} className="-mx-3 grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-1 rounded-lg px-3 py-3 transition-colors hover:bg-kumo-tint">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-base font-semibold text-kumo-strong">{k.name}</span>
              <span className="text-sm text-kumo-subtle">
                {k.kind === "kpi" ? `KPI · ${k.name} up → price ${k.expected} · ${measured(k)}` : `${CANDIDATE_KIND_WORD[k.kind]} · more favourable → price ${k.expected}`}
                {k.foundIn.length > 0 && ` · read in ${k.foundIn.length} ${k.foundIn.length === 1 ? "event" : "events"} that moved the stock`}
              </span>
            </span>
            <span className="flex items-center gap-2">
              <ConfidenceBadge level={k.level === "none" || !k.level ? "noise" : k.level} />
              <CaretRightIcon size={16} weight="bold" aria-hidden className="text-kumo-subtle" />
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

export async function DriversFound({ symbol }: { symbol: string }) {
  const { events, moves, kpis, chart } = await driverFindings(symbol);
  if (events.length === 0 && kpis.length === 0) return null;
  const from = chart.price[0]?.date ?? events[0]?.day ?? "";
  const to = chart.price.at(-1)?.date ?? events.at(-1)?.day ?? "";
  const weeks = moves.filter((m) => m.startDay >= from);
  return (
    <Section title="How the price drivers were found">
      <div className="flex flex-col gap-12">
        <Step n={1} title={`Events · ${events.length}`}>
          <EventsTimeline events={events.map((e) => ({ day: e.day, kind: e.kind, title: decodeEntities(e.title), moved: e.moveId !== null }))} from={from} to={to} />
          <Drawers>
            <Drawer icon={<CalendarDotsIcon size={16} aria-hidden />} title={`Every event · ${events.length}`}>
              <EventList symbol={symbol} events={events} />
            </Drawer>
          </Drawers>
        </Step>
        <Step n={2} title={`When the stock moved · ${weeks.length} ${weeks.length === 1 ? "week" : "weeks"}`}>
          <KpiDriverChart
            kpi={[]}
            unit="ratio"
            currency={null}
            kpiLabel=""
            price={chart.price}
            indexName={chart.indexName}
            markers={weeks.map((m, i) => ({ n: i + 1, date: m.startDay, end: m.endDay, verdict: m.direction === "up" ? "confirms" : "invalidates" }))}
            legend={{ confirms: `Up at least 2x its usual 5-day move, ${chart.indexName} taken out`, invalidates: `Down at least 2x its usual 5-day move, ${chart.indexName} taken out`, neutral: "" }}
            height={260}
          />
          <Drawers>
            <Drawer icon={<ArrowsDownUpIcon size={16} aria-hidden />} title={`Every week the stock moved · ${weeks.length}`}>
              <WeekList symbol={symbol} moves={weeks} events={events} />
            </Drawer>
          </Drawers>
        </Step>
        <Step n={3} title={`Price driver candidates · ${kpis.length}`}>
          {kpis.length ? (
            <CandidateList symbol={symbol} kpis={kpis} />
          ) : (
            <p className="text-base text-kumo-subtle">Not listed yet.</p>
          )}
        </Step>
      </div>
    </Section>
  );
}
