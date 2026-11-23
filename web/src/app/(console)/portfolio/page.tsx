import { Badge } from "@cloudflare/kumo";
import { ChartLineUpIcon } from "@phosphor-icons/react/ssr";
import { KTable, KTableBody, KTableCell, KTableHead, KTableHeader, KTableRow } from "@/console/kumo";
import { day, price, signedPct } from "@/console/format";
import { CompanyLogo } from "@/console/market";
import { type PortfolioRow, portfolioView } from "@/console/portfolio-queries";
import { ReturnChart } from "@/console/return-chart";
import { Card, ComingNext, PageHeader } from "@/console/ui";
import { TableSearch } from "@/console/table-search";
import { SOURCED_CLASS } from "@/console/sourced";

export const metadata = { title: "Portfolio" };

/**
 * A value one of his posts stated: the value itself is the link to that post (SOURCES-ONE-CLICK-1123: one click on the
 * figure, dotted underline, no « his post » line beside it).
 */
function Cited({ row, field, children }: { row: PortfolioRow; field: string; children: React.ReactNode }) {
  const cite = row.provenance[field]?.cite;
  if (!cite) return <>{children}</>;
  return (
    <a href={cite.post} target="_blank" rel="noreferrer" className={SOURCED_CLASS}>
      {children}
    </a>
  );
}

const empty = <span className="text-kumo-subtle">–</span>;

function ReturnCell({ row }: { row: PortfolioRow }) {
  if (row.return !== null) {
    return <span className={`font-mono tabular ${row.return >= 0 ? "text-dualis-long" : "text-dualis-short"}`}>{signedPct(row.return)}</span>;
  }
  if (row.reportedReturn !== null) {
    return (
      <span className="flex flex-col items-end">
        <Cited row={row} field="reportedReturn">
          <span className={`font-mono tabular ${row.reportedReturn >= 0 ? "text-dualis-long" : "text-dualis-short"}`}>{signedPct(row.reportedReturn)}</span>
        </Cited>
        <span className="text-sm text-kumo-subtle">on {day(row.reportedReturnAsOf!)}</span>
      </span>
    );
  }
  return empty;
}

/** Thierry's positions: his P&L against the S&P 500 since he entered, then one row per position. */
export default async function PortfolioPage() {
  const { positions, lines, allWeighted } = await portfolioView();

  return (
    <>
      <PageHeader title="Portfolio" />

      <Card title={allWeighted ? "Portfolio vs S&P 500, since inception" : "Each position vs S&P 500, since its entry"}>
        <div className="p-5">
          {lines.length === 0 ? (
            <ComingNext
              bare
              icon={<ChartLineUpIcon size={40} className="text-kumo-inactive" />}
              title="No entry yet"
              description="Add a position's entry date and price on its row."
            />
          ) : (
            <ReturnChart lines={lines} />
          )}
        </div>
      </Card>

      <TableSearch placeholder="Search a position">
      <div className="overflow-x-auto rounded-lg bg-kumo-base ring-1 ring-kumo-hairline">
        <KTable>
          <KTableHeader>
            <KTableRow>
              <KTableHead className="pl-6">Company</KTableHead>
              <KTableHead>Direction</KTableHead>
              <KTableHead className="text-right">Entry</KTableHead>
              <KTableHead className="text-right">Current</KTableHead>
              <KTableHead className="text-right">Return</KTableHead>
              <KTableHead className="pr-6 text-right">Weight</KTableHead>
            </KTableRow>
          </KTableHeader>
          <KTableBody>
            {positions.map((p) => (
              <KTableRow key={p.symbol}>
                <KTableCell className="py-4 pl-6">
                  <span className="inline-flex items-center gap-3">
                    <CompanyLogo src={p.logoUrl} name={p.name ?? p.symbol} size={32} />
                    <span className="flex flex-col">
                      <span className="text-base font-medium text-kumo-strong">{p.name ?? p.symbol}</span>
                      <span className="flex items-center gap-2 font-mono text-[12px] text-kumo-subtle">
                        {p.symbol}
                        {p.status === "closed" && <Badge variant="outline">Closed</Badge>}
                      </span>
                    </span>
                  </span>
                </KTableCell>
                <KTableCell className="py-4">
                  {p.direction ? (
                    <Cited row={p} field="direction">
                      <Badge variant="secondary" className={p.direction === "long" ? "bg-dualis-long-soft text-dualis-long" : "bg-dualis-short-soft text-dualis-short"}>
                        {p.direction === "long" ? "Long" : "Short"}
                      </Badge>
                    </Cited>
                  ) : (
                    empty
                  )}
                </KTableCell>
                <KTableCell className="py-4 text-right">
                  {p.entryPrice !== null ? (
                    <span className="flex flex-col items-end">
                      <span className="font-mono tabular text-kumo-strong">
                        {price(p.entryPrice)} <span className="text-kumo-subtle">{p.currency}</span>
                      </span>
                      {p.entryDate && <span className="text-sm text-kumo-subtle">{day(p.entryDate)}</span>}
                    </span>
                  ) : (
                    empty
                  )}
                </KTableCell>
                <KTableCell className="py-4 text-right">
                  {p.close !== null ? (
                    <span className="flex flex-col items-end">
                      <span className="font-mono tabular text-kumo-strong">
                        {price(p.close)} <span className="text-kumo-subtle">{p.currency}</span>
                      </span>
                      {p.quoteDate && <span className="text-sm text-kumo-subtle">{day(p.quoteDate)}</span>}
                    </span>
                  ) : (
                    empty
                  )}
                </KTableCell>
                <KTableCell className="py-4 text-right">
                  <ReturnCell row={p} />
                </KTableCell>
                <KTableCell className="py-4 pr-6 text-right font-mono tabular">{p.weight !== null ? `${(p.weight * 100).toFixed(1)}%` : empty}</KTableCell>
              </KTableRow>
            ))}
          </KTableBody>
        </KTable>
      </div>
      </TableSearch>

    </>
  );
}
