import { asc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { driverEvents, kpiDrivers, priceMoves } from "@/db/schema/analysis";
import { goldNewsItems, goldNewsLinks } from "@/db/schema/news";
import { documentPages, documents } from "@/db/schema/documents";
import * as gold from "@/db/schema/gold";
import * as silver from "@/db/schema/silver";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { testDb } from "@/test/db";
import { reversal, seedNote, setReversal } from "@/test/price-drivers";
import type { StoredSeries } from "./dimensions/analysis/series";
import { driverTests, eventRows, kpiPeriods, kpiSource, measureKpi, parseCandidates, parseFormula, promoteKpis, type KpiPayload } from "./dimensions/kpi-drivers";
import { marketReactionSource, promoteMarketReactions } from "./dimensions/market-reaction";
import { indexesFor, localIndex } from "./benchmark";
import type { SourceContext } from "./types";

/** Steps A and B of docs/architecture.md: Price Driver Candidates read in the events of the significant unbiased moves, then the confidence that each is a Price Driver. */

const SYMBOL = "1161.HK";
const DOC = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const series = (key: string, periodType: StoredSeries["periodType"], unit: StoredSeries["unit"], points: [string, number][]): StoredSeries => ({ key, label: key, unit, currency: unit === "currency" ? "HKD" : null, sources: ["hkex"], periodType, points: new Map(points) });

describe("step B, the code half: when a candidate changed, each event crossed with the significant moves", () => {
  const margin = series("hmetric:operating-margin", "half", "ratio", [
    ["2023-03", 0.1], ["2023-09", 0.11], ["2024-03", 0.105], ["2024-09", 0.112], ["2025-03", 0.06], ["2025-09", 0.113],
  ]);
  const catalog = new Map([
    ["hmetric:operating-margin", margin],
    ["metric:operating-margin", series("metric:operating-margin", "year", "ratio", [["2023-09", 0.1], ["2024-09", 0.11], ["2025-09", 0.09]])],
    ["hline:revenue", series("hline:revenue", "half", "currency", [["2024-03", 100], ["2024-09", 110], ["2025-03", 120]])],
    ["hline:ppe", series("hline:ppe", "half", "currency", [["2024-03", 50], ["2024-09", 50], ["2025-03", 60]])],
  ]);

  it("measures a KPI at the finest period stored, a formula of stored keys period by period", () => {
    const m = measureKpi(catalog, { series: "metric:operating-margin", approximation: null }, "2023-01")!;
    expect(m.measure).toMatchObject({ source: "series", periodType: "half", unit: "ratio", label: "hmetric:operating-margin, half years" });
    const f = measureKpi(catalog, { series: null, approximation: "line:revenue / line:ppe" }, "2023-01")!;
    expect(f.measure).toMatchObject({ source: "formula", periodType: "half", unit: "ratio" });
    expect(f.points.get("2025-03")).toBeCloseTo(2);
    expect(parseFormula("line:revenue / made:up", catalog)).toBeNull();
    expect(measureKpi(catalog, { series: null, approximation: null }, "2023-01")).toBeNull();
  });

  it("computes each period's change on a year earlier and the release that first reported it; the size is not judged here", () => {
    const m = measureKpi(catalog, { series: "hmetric:operating-margin", approximation: null }, "2023-01")!;
    const periods = kpiPeriods(m.points, m.measure, [{ id: "R-int", day: "2025-05-28" }, { id: "R-report", day: "2025-05-30" }, { id: "R-final", day: "2025-12-15" }], "2023-01");
    const mar25 = periods.find((p) => p.period === "2025-03")!;
    expect(mar25).toMatchObject({ changeKind: "points", significant: false, why: null, releaseId: "R-int", releaseDay: "2025-05-28" });
    expect(mar25.change).toBeCloseTo(-0.045);
    expect(periods.find((p) => p.period === "2025-09")).toMatchObject({ releaseId: "R-final" });
    expect(periods.find((p) => p.period === "2023-03")).toMatchObject({ change: null, prior: null });
  });

  it("crosses each event with the KPI and the price: confirms, invalidates, other cause, nothing", () => {
    const ev = (id: string, kind: "release" | "news" | "filing", day: string, moveId: string | null) => ({ id: `${SYMBOL}|${kind}:${id}`, symbol: SYMBOL, kind, sourceId: id, day, title: id, url: null, stock: -0.1, benchReturn: 0, beta: 1, reaction: -0.1, z: moveId ? -3 : -0.5, bench: "Hang Seng", moveId, rebuiltAt: new Date() });
    const periods = [
      { period: "2025-03", periodType: "half" as const, value: 0.06, prior: 0.105, change: -0.045, changeKind: "points" as const, significant: true, why: "w", releaseId: `${SYMBOL}|release:A`, releaseDay: "2025-05-28", cite: null },
      { period: "2025-09", periodType: "half" as const, value: 0.113, prior: 0.112, change: 0.001, changeKind: "points" as const, significant: false, why: "w", releaseId: `${SYMBOL}|release:B`, releaseDay: "2025-12-15", cite: null },
      { period: "2026-03", periodType: "half" as const, value: 0.2, prior: 0.06, change: 0.14, changeKind: "points" as const, significant: true, why: "w", releaseId: `${SYMBOL}|release:C`, releaseDay: "2026-05-26", cite: null },
    ];
    const moves = [{ id: "M-down", direction: "down" as const }];
    const rows = eventRows([ev("A", "release", "2025-05-28", "M-down"), ev("W", "filing", "2024-05-17", "M-down"), ev("B", "release", "2025-12-15", null), ev("C", "release", "2026-05-26", null), ev("N", "news", "2026-01-02", null)], periods, "up", moves);
    expect(rows.map((r) => [r.sourceId, r.kpiMoved, r.priceMoved, r.result])).toEqual([
      ["A", true, true, "confirms"],
      ["W", null, true, "other-cause"],
      ["B", false, false, "nothing"],
      ["C", true, false, "invalidates"],
      ["N", null, false, "nothing"],
    ]);
    // KPI down => price up: the same down week invalidates it.
    expect(eventRows([ev("A", "release", "2025-05-28", "M-down")], periods, "down", moves)[0].result).toBe("invalidates");
    // A significant unbiased move IS the price moving: no fundamental / market / unknown verdict filters it (rejected, Kevin 2026-11-25).
    expect(rows[0]).not.toHaveProperty("week");
    expect(driverTests(rows, moves)).toEqual({ changes: 2, followed: 1, against: 1, moves: 1, explained: 1, explainedMoveIds: ["M-down"] });
  });

  it("keeps any number of candidates of three kinds, where each was read; a series or a formula only for a stored KPI", () => {
    expect(parseCandidates(JSON.stringify({ candidates: [] }), catalog)).toEqual([]);
    const labels = new Map([["M1", "ev-1"], ["M2", "ev-2"]]);
    const got = parseCandidates(
      JSON.stringify({
        candidates: [
          { name: "Operating margin", kind: "kpi", why: "w", expected: "up", found: ["M1", "M9"], series: "metric:operating-margin" },
          { name: "Asset turn", kind: "kpi", why: "w", expected: "up", found: [], series: "made-up", formula: "line:revenue / line:ppe" },
          { name: "Utilization", kind: "kpi", why: "w", expected: "up", series: null, formula: "revenue / PP&E" },
          { name: "Beauty subsidy", kind: "policy", why: "w", expected: "up", found: ["M2"], series: "metric:operating-margin" },
        ],
      }),
      catalog,
      labels,
    );
    expect(got.map((k) => [k.name, k.kind, k.series, k.approximation, k.foundIn])).toEqual([
      ["Operating margin", "kpi", "metric:operating-margin", null, ["ev-1"]],
      ["Asset turn", "kpi", null, "line:revenue / line:ppe", []],
      ["Utilization", "kpi", null, null, []],
      ["Beauty subsidy", "policy", null, null, ["ev-2"]],
    ]);
    expect(() => parseCandidates(JSON.stringify({ candidates: [{ name: "X", kind: "kpi", why: "w", expected: "sideways" }] }), catalog)).toThrow(/sideways/);
    expect(() => parseCandidates(JSON.stringify({ candidates: [{ name: "X", kind: "macro", why: "w", expected: "up" }] }), catalog)).toThrow(/macro/);
  });
});

describe("steps A and B end to end on the stored events and moves", () => {
  let db: Db;
  let close: () => Promise<void>;
  const day = (d: number) => new Date(Date.UTC(2024, 0, 1) + d * 86_400_000).toISOString().slice(0, 10);
  const NEWS = "00000000-0000-4000-8000-0000000000a1";
  const PW = 500; // a profit warning (filing) on 2025-05-15, the stock falls 20% that week; the interim report follows on day 510.
  beforeEach(async () => {
    ({ db, close } = await testDb());
    const wob = (i: number) => 0.01 * Math.sin(i * 1.7) * Math.cos(i * 0.37);
    let c = 100;
    const bars = Array.from({ length: 700 }, (_, i) => {
      if (i > 0) c *= 1 + (i === PW + 1 ? -0.2 : wob(i));
      return { date: day(i), close: c };
    });
    await db.insert(gold.priceBars).values(bars.map((b) => ({ symbol: SYMBOL, date: b.date, close: b.close, sources: ["yahoo"], alternatives: [] })) as never);
    await db.insert(gold.priceBars).values(bars.map((b) => ({ symbol: "^HSI", date: b.date, close: 20000, sources: ["yahoo"], alternatives: [] })) as never);
    await db.insert(gold.priceBars).values(bars.map((b) => ({ symbol: "^GSPC", date: b.date, close: 5000, sources: ["yahoo"], alternatives: [] })) as never);
    await db.insert(gold.filings).values({ id: "00000000-0000-4000-8000-0000000000f1", symbol: SYMBOL, registry: "hkex", filingKey: "f1", form: null, title: "Profit Warning", filedAt: new Date(`${day(PW)}T09:00:00Z`), url: "https://example.com/pw", language: "en", sources: ["hkex"] } as never);
    // An INDUSTRY news the same week (matched on an industry term only): as valid an event as the company's own.
    await db.insert(goldNewsItems).values({ id: NEWS, title: "Hong Kong retail sector under pressure", url: "https://example.com/retail", publisher: "SCMP", summary: null, imageUrl: null, publishedAt: new Date(`${day(PW)}T03:00:00Z`), firstSeenAt: new Date(`${day(PW)}T04:00:00Z`), sources: ["google-news"], symbols: [SYMBOL], markets: ["HK"] } as never);
    await db.insert(goldNewsLinks).values({ newsItemId: NEWS, symbol: SYMBOL, market: "HK", publishedAt: new Date(`${day(PW)}T03:00:00Z`), firstSeenAt: new Date(`${day(PW)}T04:00:00Z`), matchKinds: ["industry"], matchedTerms: ["Hong Kong retail"], sources: ["google-news"], matches: [{ kind: "industry", term: "Hong Kong retail", sources: ["google-news"] }] } as never);
    for (const [n, d, title] of [[1, 150, "Interim Results 2024"], [2, 510, "Interim Results 2025"]] as const) {
      await db.insert(documents).values({ id: DOC(n), symbol: SYMBOL, registry: "hkex", kind: "report", form: null, title, filedAt: new Date(`${day(d)}T06:00:00Z`), language: "en", viewUrl: null, format: "pdf", pageCount: 1, sources: ["hkex"] } as never);
      await db.insert(documentPages).values({ documentId: DOC(n), page: 1, text: `Service margin was ${n === 1 ? "30.0%" : "22.0%"} for the period.` });
    }
  });
  afterEach(async () => close());

  it("A reads every event of a significant unbiased move (an industry news included, no macro filter) and deduces the candidates; B ties a profit warning to its period and counts the two tests; Thierry's inputs are in the prompts, outside the keys", async () => {
    await seedNote(db, SYMBOL, "I think the market only cares about the service margin here.");
    const ctx: SourceContext = { env: {}, fetch, db };
    const mr = await marketReactionSource.fetch(SYMBOL, ctx);
    expect(mr.error).toBeUndefined();
    await promoteMarketReactions(db, [{ id: "m", subject: SYMBOL, error: null, payload: mr.payload, fetchedAt: new Date() } as never]);
    const events = await db.select().from(driverEvents);
    expect(events.map((e) => [e.kind, e.day]).sort()).toEqual([["filing", day(PW)], ["news", day(PW)], ["release", day(150)], ["release", day(510)]].sort());
    const industry = events.find((e) => e.kind === "news")!;
    const warning = events.find((e) => e.kind === "filing")!;
    expect(warning).toMatchObject({ bench: "Hang Seng" });
    expect(warning.moveId).not.toBeNull();
    const [move] = await db.select().from(priceMoves);
    expect(move).toMatchObject({ id: warning.moveId, direction: "down", bench: "Hang Seng" });
    // The industry news sits in the same significant move: nothing judges the week, the move is valid as it is.
    expect(industry.moveId).toBe(move.id);

    let calls = 0;
    const fake: Complete = async ({ system, prompt }) => {
      calls++;
      const NOTE = "I think the market only cares about the service margin here.";
      if (system.includes("PRICE DRIVER CANDIDATES of one stock")) {
        // Step A reads the events whose week was a significant unbiased move: the profit warning AND the industry news, not the quiet reports.
        expect(prompt).toContain(`M1 ${day(PW)} Filing: Profit Warning (the stock moved -`);
        expect(prompt).toContain(`M2 ${day(PW)} News: Hong Kong retail sector under pressure (the stock moved -`);
        expect(prompt).not.toContain("M3 ");
        expect(system).toContain("every event listed is valid, an industry news as much as a company one");
        expect(system).not.toMatch(/macro \(oil|is not\./);
        expect(prompt).toContain(NOTE);
        return {
          text: JSON.stringify({
            candidates: [
              { name: "Service margin", kind: "kpi", why: "Pricing power.", expected: "up", found: ["M1"], series: null, formula: null },
              { name: "Store count", kind: "kpi", why: "Reach.", expected: "up", found: ["M2"], series: null, formula: null },
              { name: "Beauty licence rules", kind: "policy", why: "Who may operate.", expected: "up", found: ["M1"], series: null, formula: null },
            ],
          }),
          model: "fake",
        };
      }
      if (system.includes("ONE candidate price driver that is not a figure")) {
        // Titles only, never the price.
        expect(prompt).not.toMatch(/beyond the/);
        return { text: JSON.stringify({ changes: [{ event: "E2", change: "down", why: "rules tightened" }, { event: "E99", change: "up", why: "x" }] }), model: "fake" };
      }
      if (system.includes("You read company announcements")) {
        expect(prompt).toContain("E1 " + day(PW) + " Filing: Profit Warning. Next report: " + day(510));
        return { text: JSON.stringify({ events: [{ event: "E1", announces: true, what: "profit for the six months expected to fall" }, { event: "E2", announces: false, what: null }] }), model: "fake" };
      }
      if (system.includes("You read ONE figure")) {
        if (prompt.includes("Store count")) return { text: JSON.stringify({ values: [] }), model: "fake" };
        return {
          text: JSON.stringify({ values: [{ report: "R1", page: 1, period: "2024-03", periodType: "half", value: 30, unit: "percent", quote: "Service margin was 30.0%" }, { report: "R2", page: 1, period: "2025-03", periodType: "half", value: 22, unit: "percent", quote: "Service margin was 22.0%" }, { report: "R2", page: 1, period: "2024-09", periodType: "half", value: 25, unit: "percent", quote: "not printed there" }] }),
          model: "fake",
        };
      }
      if (system.includes("when ONE fundamental KPI")) {
        // Step 4 sees the change and the announcement before the report, and names which disclosed it first.
        expect(prompt).toContain("P1 6 months to Mar-25: 22.0% vs 30.0% a year earlier (-8.0 pts).");
        expect(prompt).toContain("Announced before it: A1 " + day(PW) + " Filing: Profit Warning (it announces: profit for the six months expected to fall)");
        return { text: JSON.stringify({ periods: [{ period: "P1", moved: true, why: "margin fell 8 points, its largest drop", first: "A1" }] }), model: "fake" };
      }
      if (system.startsWith("You shorten ONE verdict")) return { text: "Thin: the price moved on other facts.", model: "fake" };
      // Step B: the confidence reads the event table and the two tests on every significant move, no week verdict.
      expect(prompt).toContain("B) 1 significant unbiased 1-week moves: the candidate changed on the first day of ");
      expect(prompt).not.toMatch(/fundamental|judged/);
      expect(prompt).toMatch(/Filing: Profit Warning\. (KPI|Candidate).*; price -\d+\.\d% beyond the Hang Seng over 5 trading days \(\d+\.\dx its usual move\), a significant unbiased move\. Result: (confirms|other cause)\./);
      expect(prompt).toContain(NOTE);
      // The architecture's word « noise » is stored as `none`.
      return { text: JSON.stringify({ level: prompt.includes("Store count") ? "noise" : "weak", reason: "Thin evidence." }), model: "fake" };
    };
    const kctx: SourceContext = { env: { CLAUDE_OAUTH_TOKEN: "x" }, fetch, db, complete: fake };
    const out = await kpiSource.fetch(SYMBOL, kctx);
    expect(out.error).toBeUndefined();
    await promoteKpis(db, [{ id: "b", subject: SYMBOL, error: null, payload: out.payload, fetchedAt: new Date() } as never]);
    const ks = await db.select().from(kpiDrivers);
    const pw = (k: (typeof ks)[number]) => k.rows.find((r) => r.kind === "filing")!;
    // The reversal is not this dimension's any more (kpi-reversal reads it against the narrative): none yet.
    expect(ks.map((k) => [k.name, k.kind, k.expected, k.level, k.signal, k.reversal])).toEqual([["Service margin", "kpi", "up", "weak", null, null], ["Store count", "kpi", "up", "none", null, null], ["Beauty licence rules", "policy", "up", "weak", null, null]]);
    expect(ks.map((k) => k.id)).toEqual([`${SYMBOL}:kpi:service-margin`, `${SYMBOL}:kpi:store-count`, `${SYMBOL}:kpi:beauty-licence-rules`]);
    expect(ks[0].foundIn).toEqual([warning.id]);
    // A candidate deduced from the industry news alone.
    expect(ks[1].foundIn).toEqual([industry.id]);
    // The two tests, counted by code: the margin drop came with the one move, the store count never changed.
    expect(ks[0].tests).toEqual({ changes: 1, followed: 1, against: 0, moves: 1, explained: 1, explainedMoveIds: [move.id] });
    expect(ks[0]).toMatchObject({ direction: "down" });
    expect(ks[1].tests).toMatchObject({ changes: 0, moves: 1, explained: 0 });
    // A policy changes at the events the AI names (an unknown label dropped), crossed with the price like a KPI.
    expect(pw(ks[2])).toMatchObject({ kpiMoved: true, changeUp: false, priceMoved: true, result: "confirms", kpiWhy: "rules tightened" });
    expect(ks[2]).toMatchObject({ measure: null, periods: [], direction: "down" });
    expect(ks[2].tests).toMatchObject({ changes: 1, followed: 1, explained: 1 });
    // A value whose quote is not on its page is dropped; the Mar-25 margin drop is first disclosed by the warning.
    expect(ks[0].periods.map((p) => p.period)).toEqual(["2024-03", "2025-03"]);
    expect(ks[0].periods[1]).toMatchObject({ significant: true, releaseId: warning.id, why: "margin fell 8 points, its largest drop" });
    expect(pw(ks[0])).toMatchObject({ kpiMoved: true, priceMoved: true, result: "confirms", period: "2025-03" });
    expect(pw(ks[1])).toMatchObject({ kpiMoved: null, priceMoved: true, result: "other-cause" });
    // The same price move under every KPI.
    for (const f of ["reaction", "z", "moveId", "stock"] as const) expect(pw(ks[0])[f]).toEqual(pw(ks[1])[f]);
    // The report after the warning no longer counts the same move twice.
    expect(ks[0].rows.find((r) => r.day === day(510))).toMatchObject({ kpiMoved: null });
    expect(ks[0].reason).toBe("Thin: the price moved on other facts.");
    // Stored once: a second run asks nothing, even after Thierry said something new (his inputs are in no key).
    const before = calls;
    await seedNote(db, SYMBOL, "A second thought, pushed later.");
    await kpiSource.fetch(SYMBOL, kctx);
    expect(calls).toBe(before);
    // A later run keeps the reversal `kpi-reversal` stored on a driver still trusted; a driver no longer trusted loses it.
    const read = reversal("long", { strength: "weak", why: "The margin is turning up." });
    await setReversal(db, SYMBOL, read);
    const payload = out.payload as KpiPayload;
    await promoteKpis(db, [{ id: "c", subject: SYMBOL, error: null, payload: { ...payload, drivers: payload.drivers }, fetchedAt: new Date() } as never]);
    const again = await db.select().from(kpiDrivers).orderBy(asc(kpiDrivers.rank));
    expect(again.map((k) => [k.level, k.signal, k.reversal?.why ?? null])).toEqual([["weak", "weak", "The margin is turning up."], ["none", null, null], ["weak", "weak", "The margin is turning up."]]);
    expect((await db.select().from(silver.judgments)).map((j) => j.subjectKind).sort()).toEqual(["candidate-changes", "event-announces", "event-announces", "kpi-candidates", "kpi-moves", "kpi-read", "kpi-read", "kpi-reason", "kpi-reason", "kpi-reason", "kpi-verdict", "kpi-verdict", "kpi-verdict"]);
  });

  it("measures each stock against its OWN market's index", () => {
    expect(localIndex("1161.HK").name).toBe("Hang Seng");
    expect(localIndex("101160.KQ").symbol).toBe("^KQ11");
    expect(indexesFor(["1161.HK", "SPCB"])).toEqual(["^GSPC", "^HSI"]);
  });
});
