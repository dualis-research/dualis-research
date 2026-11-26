import { describe, expect, it } from "vitest";
import { daysAgo, isoDate } from "../../markets";
import type { SourceContext } from "../../types";
import { HISTORY_YEARS } from "../../history";
import { companiesHouse, dart, historyStart, secEdgar, tdnet } from "./sources";

/** Every registry reads `HISTORY_YEARS` (10) back (Kevin 2026-11-19, Thierry 2026-11-26): a past price move is explained only by the filings around it. */

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const ctxOf = (fetch: (url: URL) => Response): SourceContext => ({ env: { DART_API_KEY: "k", COMPANIES_HOUSE_API_KEY: "k" }, fetch: (async (u: string | URL | Request) => fetch(new URL(String(u)))) as typeof globalThis.fetch });
const day = (n: number) => isoDate(daysAgo(n));

describe("filings: 10 years of history from every registry", () => {
  it("SEC keeps every filing of the last 10 years, past the old 200 cap, and none older", async () => {
    const dates = Array.from({ length: 400 }, (_, i) => day(i * 12)); // one filing every 12 days, back ~13 years
    const recent = { accessionNumber: dates.map((_, i) => `a${i}`), form: dates.map(() => "8-K"), filingDate: dates, primaryDocument: dates.map(() => "x.htm") };
    const ctx = ctxOf((url) => (url.pathname.endsWith("company_tickers.json") ? json({ 0: { cik_str: 1, ticker: "CCLD" } }) : json({ cik: "1", name: "CareCloud", filings: { recent } })));
    const out = await secEdgar.fetch("CCLD", ctx);
    const items = secEdgar.extract(out.payload, "CCLD");
    expect(items.length).toBeGreaterThan(200);
    expect(items.every((f) => f.filedAt >= daysAgo(HISTORY_YEARS * 366))).toBe(true);
    expect(items.length).toBeLessThan(400);
    expect(isoDate(items.at(-1)!.filedAt) >= isoDate(historyStart())).toBe(true);
  });

  it("DART reads every page of a 10-year window", async () => {
    const asked: string[] = [];
    const ctx = ctxOf((url) => {
      asked.push(`${url.searchParams.get("bgn_de")}:${url.searchParams.get("page_no")}`);
      const page = Number(url.searchParams.get("page_no"));
      return json({ status: "000", total_page: 3, list: [{ rcept_no: `r${page}`, report_nm: "분기보고서", rcept_dt: day(page * 400).replace(/-/g, "") }] });
    });
    const out = await dart.fetch("101160.KQ", ctx);
    expect(out.error).toBeUndefined();
    expect(asked).toEqual([1, 2, 3].map((p) => `${isoDate(historyStart()).replace(/-/g, "")}:${p}`));
    expect(dart.extract(out.payload, "101160.KQ").map((f) => f.filingKey)).toEqual(["r1", "r2", "r3"]);
  });

  it("Companies House pages until it reaches past 10 years, and keeps only those 10 years", async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ transaction_id: `t${i}`, date: day(i * 20), description: "accounts", category: "accounts", type: "AA" }));
    const starts: number[] = [];
    const ctx = ctxOf((url) => {
      const start = Number(url.searchParams.get("start_index"));
      starts.push(start);
      return json({ items: all.slice(start, start + 100) });
    });
    const out = await companiesHouse.fetch("AT.L", ctx);
    expect(starts).toEqual([0, 100]);
    const items = companiesHouse.extract(out.payload, "AT.L");
    expect(items.length).toBe(all.filter((f) => f.date >= isoDate(historyStart())).length);
  });

  it("TDnet keeps the mirror's 10 years, not the last 100 items", async () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ Tdnet: { id: `d${i}`, title: "決算短信", pubdate: `${day(i * 10)} 15:00:00`, document_url: null } }));
    const ctx = ctxOf((url) => {
      expect(Number(url.searchParams.get("limit"))).toBeGreaterThanOrEqual(500);
      return json({ items });
    });
    const out = await tdnet.fetch("4238.T", ctx);
    const got = tdnet.extract(out.payload, "4238.T");
    expect(got.length).toBe(items.filter((i) => i.Tdnet.pubdate.slice(0, 10) >= isoDate(historyStart())).length);
    expect(got.length).toBeGreaterThan(100);
  });
});
