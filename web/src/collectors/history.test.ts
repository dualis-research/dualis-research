import { describe, expect, it } from "vitest";
import { MOVE_YEARS } from "./dimensions/analysis/facts";
import { YEARS as DOCUMENT_YEARS } from "./dimensions/filing-documents";
import { EDINET_HISTORY_YEARS, FILINGS_HISTORY_YEARS } from "./dimensions/filings/sources";
import { REPORT_HISTORY_YEARS, STATEMENT_YEARS } from "./dimensions/financials/sources";
import { KPI_HISTORY_YEARS, KPI_YEARS } from "./dimensions/kpi-drivers";
import { EVENT_YEARS } from "./dimensions/market-reaction/events";
import { MOVE_HISTORY_DAYS } from "./dimensions/market-reaction";
import { yahooChartUrl } from "./dimensions/price/sources";
import { HISTORY_YEARS } from "./history";

describe("one history window for the whole analysis (Thierry 2026-11-26: 10 years for every stock)", () => {
  it("is 10 years", () => expect(HISTORY_YEARS).toBe(10));

  it("every window reads it: moves, events, Price Driver tests, KPIs, filings, report texts, statements", () => {
    for (const years of [MOVE_YEARS, EVENT_YEARS, KPI_YEARS, KPI_HISTORY_YEARS, FILINGS_HISTORY_YEARS, EDINET_HISTORY_YEARS, DOCUMENT_YEARS, REPORT_HISTORY_YEARS, STATEMENT_YEARS]) expect(years).toBe(HISTORY_YEARS);
  });

  it("prices go one year further, for the trailing year the first move's z-score needs", () => {
    expect(MOVE_HISTORY_DAYS).toBeGreaterThanOrEqual((HISTORY_YEARS + 1) * 365);
    const url = new URL(yahooChartUrl("1161.HK", new Date("2026-11-26T00:00:00Z")));
    expect(url.searchParams.get("interval")).toBe("1d");
    expect(new Date(Number(url.searchParams.get("period1")) * 1000).toISOString().slice(0, 10)).toBe("2015-11-26");
  });
});
