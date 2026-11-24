import { Badge } from "@cloudflare/kumo";
import { utc } from "@/console/format";
import { INPUT_TABS, type InputTab, InputsTabs } from "@/console/inputs-tabs";
import { KTable, KTableBody, KTableCell, KTableHead, KTableHeader, KTableRow } from "@/console/kumo";
import Link from "@/console/link";
import { getInput, inputCounts, listInputs } from "@/console/queries";
import { RowLink } from "@/console/row-link";
import { SlideOver } from "@/console/slide-over";
import { TableSearch } from "@/console/table-search";
import { Fact, FactList, PageHeader } from "@/console/ui";
import type { GoldThierryInput } from "@/db/schema/thierry-inputs";

export const metadata = { title: "Thierry's inputs" };

const KIND_WORD: Record<GoldThierryInput["kind"], string> = { question: "Question", view: "View", analysis: "Analysis", info: "Info", file: "File" };
const SCOPE_WORD: Record<GoldThierryInput["scope"], string> = { ticker: "Ticker", watchlist: "Watchlist", portfolio: "Portfolio", general: "General" };

/** The ticker with its company under it (a link to its Analysis page when it is on the watchlist), else the scope word. */
function About({ input }: { input: GoldThierryInput }) {
  if (input.scope !== "ticker" || !input.symbol) return <span className="text-kumo-default">{SCOPE_WORD[input.scope]}</span>;
  return (
    <span className="flex flex-col">
      {input.onWatchlist ? (
        <Link href={`/tickers/${encodeURIComponent(input.symbol)}`} className="font-mono text-[13px] font-semibold text-kumo-default hover:text-kumo-link">
          {input.symbol}
        </Link>
      ) : (
        <span className="font-mono text-[13px] font-semibold text-kumo-default">{input.symbol}</span>
      )}
      {input.company && <span className="text-sm text-kumo-subtle">{input.company}</span>}
    </span>
  );
}

/** What Thierry's Claude pushed (`record_inputs`): his questions, views, analyses, information and files. Read only. */
export default async function InputsPage({ searchParams }: { searchParams: Promise<{ tab?: string; input?: string }> }) {
  const { tab: raw, input: inputId } = await searchParams;
  const tab = INPUT_TABS.find((t) => t.value === raw) ?? INPUT_TABS[0];
  const [rows, byKind, selected] = await Promise.all([listInputs({ kind: tab.kind ?? undefined }), inputCounts(), inputId ? getInput(inputId) : null]);
  const total = Object.values(byKind).reduce((a, b) => a + b, 0);
  const counts = Object.fromEntries(INPUT_TABS.map((t) => [t.value, t.kind ? (byKind[t.kind] ?? 0) : total])) as Record<InputTab, number>;
  const base = tab.value === "all" ? "/inputs" : `/inputs?tab=${tab.value}`;
  const panelHref = (id: string) => `${base}${base.includes("?") ? "&" : "?"}input=${id}`;

  return (
    <>
      <PageHeader title="Thierry's inputs" />
      <TableSearch placeholder="Search his words, a company or ticker" tabs={<InputsTabs value={tab.value} counts={counts} />}>
        {rows.length === 0 ? (
          <p className="text-base text-kumo-subtle">{total === 0 ? "Nothing pushed from Claude yet." : "Nothing of this kind yet."}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg bg-kumo-base ring-1 ring-kumo-hairline">
            <KTable>
              <KTableHeader>
                <KTableRow>
                  <KTableHead className="pl-6">Date</KTableHead>
                  <KTableHead>Kind</KTableHead>
                  <KTableHead>Ticker</KTableHead>
                  <KTableHead className="pr-6">Text</KTableHead>
                </KTableRow>
              </KTableHeader>
              <KTableBody>
                {rows.map((r) => (
                  <RowLink key={r.id} href={panelHref(r.id)} label={`${KIND_WORD[r.kind]}, ${utc(r.saidAt)}`}>
                    <KTableCell className="py-4 pl-6 align-top whitespace-nowrap font-mono text-sm tabular text-kumo-default">{utc(r.saidAt)}</KTableCell>
                    <KTableCell className="py-4 align-top">
                      <Badge variant="outline">{KIND_WORD[r.kind]}</Badge>
                    </KTableCell>
                    <KTableCell className="py-4 align-top whitespace-nowrap">
                      <About input={r} />
                    </KTableCell>
                    <KTableCell className="max-w-2xl py-4 pr-6 align-top text-base text-kumo-default">
                      {r.fileName && <span className="block font-medium text-kumo-strong">{r.fileName}</span>}
                      <span className="line-clamp-2 break-words">{r.text}</span>
                    </KTableCell>
                  </RowLink>
                ))}
              </KTableBody>
            </KTable>
          </div>
        )}
      </TableSearch>

      {selected && (
        <SlideOver title={KIND_WORD[selected.kind]} subtitle={utc(selected.saidAt)} closeHref={base} size="lg">
          <p className="text-base break-words whitespace-pre-wrap text-kumo-strong">{selected.text}</p>
          <FactList>
            <Fact label="Kind">{KIND_WORD[selected.kind]}</Fact>
            <Fact label="Scope">{SCOPE_WORD[selected.scope]}</Fact>
            {selected.symbol && (
              <Fact label="Ticker">
                <About input={selected} />
              </Fact>
            )}
            {selected.fileName && <Fact label="File">{selected.fileName}</Fact>}
            <Fact label="Said at">{utc(selected.saidAt)}</Fact>
          </FactList>
        </SlideOver>
      )}
    </>
  );
}
