import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { financialMetrics, goldFinancialLines } from "@/db/schema/financials";
import * as gold from "@/db/schema/gold";
import type { Db } from "@/db/types";
import { testDb } from "@/test/db";
import { finestSeries, seriesCatalog } from "./dimensions/analysis/series";
import { deriveMetrics, secondHalves } from "./dimensions/financials/derive";
import { latestReports } from "./dimensions/financials/sources";
import type { SourceContext } from "./types";

/** Water Oasis-like: fiscal years to September, interim reports to March, HKD. */
const cite = (page: number, quote: string) => ({ document: "Report", url: "https://x/r.pdf", page, quote });
const row = (periodType: "year" | "half", periodEnd: string, line: string, value: number, statement: "income" | "balance" | "segment" = "income") => ({
  symbol: "1161.HK",
  periodType,
  periodEnd,
  line,
  statement,
  value,
  currency: "HKD",
  label: line,
  consolidated: true,
  sources: ["pdf-extract"],
  alternatives: [],
  citation: cite(9, String(value)),
});
const LINES = [
  row("year", "2025-09", "revenue", 981e6),
  row("year", "2025-09", "net-income", 82e6),
  row("year", "2025-09", "pretax-income", 110e6),
  row("year", "2025-09", "interest-expense", 8e6),
  row("year", "2025-09", "eps-basic", 0.12),
  row("year", "2025-09", "cash", 300e6, "balance"),
  row("year", "2025-09", "segment:product:Services", 700e6, "segment"),
  row("half", "2025-03", "revenue", 492e6),
  row("half", "2025-03", "net-income", 55e6),
  row("half", "2025-03", "pretax-income", 71e6),
  row("half", "2025-03", "interest-expense", 3.8e6),
  row("half", "2025-03", "eps-basic", 0.08),
  row("half", "2025-03", "cash", 280e6, "balance"),
  row("half", "2025-03", "segment:product:Services", 350e6, "segment"),
  row("half", "2026-03", "revenue", 515e6),
  row("half", "2026-03", "net-income", 71e6),
  row("half", "2026-03", "pretax-income", 92.6e6),
  row("half", "2026-03", "interest-expense", 4e6),
];

describe("half years (HALF-YEAR-KPI-1123)", () => {
  it("derives a second half = fiscal year - first half for flows only, each input with its citation", () => {
    const h2 = secondHalves(LINES);
    expect(h2.map((l) => l.line).sort()).toEqual(["interest-expense", "net-income", "pretax-income", "revenue", "segment:product:Services"]);
    const rev = h2.find((l) => l.line === "revenue")!;
    expect(rev).toMatchObject({ periodType: "half", periodEnd: "2025-09", value: 489e6, citation: null });
    expect(rev.derivation).toMatchObject({ formula: "fiscal year to 2025-09 - first half to 2025-03", inputs: [{ periodType: "year", value: 981e6, citation: cite(9, "981000000") }, { periodType: "half", periodEnd: "2025-03" }] });
    // A half a document printed is never overwritten.
    expect(secondHalves([...LINES, row("half", "2025-09", "revenue", 1)]).find((l) => l.line === "revenue")).toBeUndefined();
  });

  it("computes margins and growth per half year; operating margin from pretax + finance costs when no operating line is printed", () => {
    const all = [...LINES, ...secondHalves(LINES)];
    const m = deriveMetrics("1161.HK", all);
    const at = (pe: string, metric: string) => m.find((x) => x.periodType === "half" && x.periodEnd === pe && x.metric === metric);
    expect(at("2026-03", "net-margin")?.value).toBeCloseTo(71 / 515, 6);
    expect(at("2025-09", "net-margin")?.value).toBeCloseTo(27 / 489, 6);
    expect(at("2026-03", "operating-margin")).toMatchObject({ formula: "(pretax income + interest expense) / revenue, no operating income line printed" });
    expect(at("2026-03", "operating-margin")?.value).toBeCloseTo(96.6 / 515, 6);
    expect(at("2026-03", "revenue-growth")).toMatchObject({ formula: "revenue / same half prior year revenue - 1" });
    expect(at("2026-03", "revenue-growth")?.value).toBeCloseTo(515 / 492 - 1, 6);
    // A printed operating income wins over the fallback.
    const printed = deriveMetrics("X", [...all, row("half", "2026-03", "operating-income", 90e6)]).find((x) => x.periodType === "half" && x.periodEnd === "2026-03" && x.metric === "operating-margin");
    expect(printed).toMatchObject({ formula: "operating-income / revenue" });
  });

  describe("on the database", () => {
    let db: Db;
    let close: () => Promise<void>;
    beforeEach(async () => ({ db, close } = await testDb()));
    afterEach(async () => close());

    it("serves hline: / hmetric: series, and a yearly KPI key draws its half years", async () => {
      const all = [...LINES.map((l) => ({ ...l, derivation: null })), ...secondHalves(LINES)];
      await db.insert(goldFinancialLines).values(all);
      await db.insert(financialMetrics).values(deriveMetrics("1161.HK", all));
      const catalog = await seriesCatalog(db, "1161.HK");
      expect(catalog.get("hline:revenue")?.points.size).toBe(3);
      expect(catalog.get("hmetric:net-margin")).toMatchObject({ label: "Net margin (half-yearly)", periodType: "half" });
      expect(finestSeries(catalog, "metric:net-margin", "2023-11-23")?.key).toBe("hmetric:net-margin");
      expect(finestSeries(catalog, "metric:net-margin", "2026-01-01")?.key).toBe("metric:net-margin");
      const [stored] = await db.select().from(goldFinancialLines).where(and(eq(goldFinancialLines.periodEnd, "2025-09"), eq(goldFinancialLines.periodType, "half"), eq(goldFinancialLines.line, "revenue")));
      expect(stored.derivation?.inputs).toHaveLength(2);
    });

    it("reads every annual and interim report of 3 years, annual ones first, newest first", async () => {
      const f = (title: string, filedAt: string, n: number) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, symbol: "1161.HK", registry: "hkex", filingKey: `k${n}`, title, filedAt: new Date(filedAt), url: `https://x/${n}.pdf`, language: "en", sources: ["hkex"] });
      await db.insert(gold.filings).values([
        f("Interim Report 2026", "2026-05-29", 1),
        f("Annual Report 2025", "2025-12-18", 2),
        f("Interim Report 2025", "2025-05-30", 3),
        f("Annual Report 2024", "2024-12-20", 4),
        f("Interim Report 2024", "2024-05-29", 5),
        f("Annual Report 2023", "2024-01-02", 6),
        f("Interim Report 2023", "2023-06-09", 7),
        f("Annual Report 2022", "2023-01-06", 8),
        f("Interim Results Announcement", "2026-05-26", 9),
      ]);
      const r = await latestReports({ db } as SourceContext, "1161.HK", new Date("2026-11-23T00:00:00Z"));
      expect(r.map((x) => `${x.kind} ${x.doc.title}`)).toEqual(["annual Annual Report 2025", "annual Annual Report 2024", "annual Annual Report 2023", "interim Interim Report 2026", "interim Interim Report 2025", "interim Interim Report 2024"]);
    });
  });
});
