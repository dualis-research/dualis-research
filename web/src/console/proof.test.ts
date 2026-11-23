import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GoldDriverEvent, GoldKpiDriver, KpiEventRow } from "@/db/schema/analysis";
import { moveArrows, NO_ITEM_EXPLAINS } from "./move-arrows";

vi.mock("@/console/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => createElement("a", { href, className }, children) }));
vi.mock("@/console/moves-chart", () => ({ MovesChart: ({ verdicts }: { verdicts?: boolean }) => createElement("div", null, verdicts ? "chart with verdicts" : "chart") }));
vi.mock("@/console/driver-steps-charts", () => ({ EventsTimeline: () => createElement("div", null, "timeline") }));
vi.mock("@/console/kpi-queries", () => ({ proofData: async () => null }));

/** PROOF-STRUCTURE-1123 + the narrative step (2026-11-24): four sections, closed, each title carrying its conclusion. */

const S = "1161.HK";
const move = (id: string, startDay: string, direction: "up" | "down") => ({ id, startDay, endDay: startDay, direction, abnormal: direction === "up" ? 0.11 : -0.09, bench: "Hang Seng" });
const arrows = moveArrows(
  [move("w1", "2025-01-08", "up"), move("w2", "2025-04-08", "up"), move("w3", "2026-08-06", "up")],
  [
    { id: "w1", kind: "fundamental", fact: "Management said Lunar New Year bookings were full.", cites: [{ kind: "news", id: "n1", title: "Lunar New Year bookings full", url: "https://example.com/n1", at: "2025-01-14T02:00:00Z", publisher: null, sources: ["google-news"] }] },
    { id: "w2", kind: "macro", fact: "Hong Kong stocks rebounded after the tariff selloff.", cites: [] },
    { id: "w3", kind: "unknown", fact: "The property news items do not explain it.", cites: [] },
  ],
);
const event = (id: string, kind: GoldDriverEvent["kind"], day: string, title: string, moveId: string | null): GoldDriverEvent => ({ id: `${S}|${kind}:${id}`, symbol: S, kind, sourceId: id, day, title, url: "https://example.com/" + id, stock: 0.1, benchReturn: 0, beta: 1, reaction: 0.1, z: 2.5, bench: "Hang Seng", moveId, rebuiltAt: new Date() });
const row = (e: GoldDriverEvent, kpiMoved: boolean | null, priceMoved: boolean, result: KpiEventRow["result"], week: KpiEventRow["week"]): KpiEventRow => ({ eventId: e.id, day: e.day, kind: e.kind, title: e.title, sourceId: e.sourceId, url: e.url, period: null, from: null, to: null, change: null, kpiWhy: kpiMoved ? "rents rose" : null, kpiMoved, stock: e.stock, reaction: e.reaction, z: e.z, moveId: e.moveId, priceMoved, result, cite: null, changeUp: kpiMoved ? true : null, week });
const events = [event("n1", "news", "2025-01-14", "Lunar New Year bookings full", "w1"), event("n2", "news", "2025-04-09", "Commercial rents rise", "w2")];
const tests = { changes: 1, followed: 0, against: 1, moves: 3, fundamentalMoves: 1, explained: 0, explainedMoveIds: [], both: 0, bothAgree: 0 };
const kpi = (rank: number, name: string, kind: GoldKpiDriver["kind"], level: GoldKpiDriver["level"], over: Partial<GoldKpiDriver> = {}): GoldKpiDriver =>
  ({ id: `${S}:kpi:${rank}`, symbol: S, rank, name, kind, foundIn: [], tests, why: "w", expected: "up", series: null, approximation: null, measure: null, periods: [], level, reason: `${name} reason.`, rows: [], confirmed: 0, invalidated: 0, signal: null, signalWhy: null, reversal: null, direction: null, asOf: new Date(), rebuiltAt: new Date(), ...over }) as GoldKpiDriver;
const kpis = [
  kpi(1, "Commercial rent levels", "industry", "none", { rows: [row(events[1], true, false, "invalidates", "market")], foundIn: [events[1].id] }),
  kpi(2, "Net income", "kpi", "strong", {
    reversal: {
      intrinsic: { state: "reversing-up", period: null, why: "Profit doubled after two years of decline." },
      leading: { probability: "high", why: "Bookings were full before the holiday.", events: [{ id: events[0].id, day: events[0].day, kind: "news", title: events[0].title, sourceId: "n1", url: events[0].url }] },
      strength: "strong",
      direction: "up",
      why: "Profit is turning up.",
      side: "long",
      stance: "against",
      turn: "inflection",
      durability: "structural",
      magnitude: { figure: "Net income", from: "HK$32M", to: "HK$60M", change: "+88%", size: "material" },
      pricedIn: "partly",
      citations: [{ documentId: "d1", page: 3, quote: "bookings for the Lunar New Year were full", title: "Interim results" }],
    },
  }),
  // A weak driver the judge reads as going WITH the story, and whose own figure keeps falling.
  kpi(3, "Hong Kong revenue", "kpi", "weak", { reversal: { intrinsic: { state: "continuing-to-fall", period: null, why: "Revenue fell again." }, leading: { probability: "none", why: "Nothing recent.", events: [] }, strength: "none", direction: "down", why: "Revenue keeps falling, as the market assumes.", side: "long", stance: "with", turn: null } }),
];
const narrative = { side: "long" as const, text: "The market prices Water Oasis as a flat, mature chain.", sideWhy: "The price sits a third under the fair value while profit halved.", drivers: [{ id: `${S}:long:1`, kpiDriverId: `${S}:kpi:2`, category: "Business economics" as const, title: "Profit is seen as stuck after the rent shock", summary: "The market assumes profit stays low." }] };
const data = { events, arrows, kpis, narrative, chart: { price: [], beta: 1, indexName: "Hang Seng", windowEnd: (d: string) => d }, industryNews: new Set(["n2"]) };

describe("the proof structure of a stock's Price Drivers", async () => {
  const { ProofView, ConfidenceBody, ReversalBody } = await import("./proof");
  const { reversalWord } = await import("@/content/reversal-words");
  const html = renderToStaticMarkup(createElement(ProofView, { symbol: S, data }));

  it("shows the four sections, in order, each title with its conclusion, all closed", () => {
    const at = (t: string) => html.indexOf(t);
    expect(at("1 · Price Driver Candidates")).toBeGreaterThan(-1);
    expect(at("1 · Price Driver Candidates")).toBeLessThan(at("2 · Confidence"));
    expect(at("2 · Confidence")).toBeLessThan(at("3 · Narrative"));
    expect(at("3 · Narrative")).toBeLessThan(at("4 · Reversals"));
    // The narrative's title carries its side and its sentence; its body the model's why and the Price Drivers it rests on.
    expect(html).toContain("Pessimistic: ");
    expect(html).toContain("The market prices Water Oasis as a flat, mature chain.");
    expect(html).toContain("The price sits a third under the fair value while profit halved.");
    expect(html).toContain("Profit is seen as stuck after the rent shock");
    expect(html).toContain(encodeURIComponent(`kdriver:${S}:kpi:2`));
    expect(html).toContain("3 found");
    expect(html).toContain("1 strong, 1 weak");
    expect(html).toContain("Net income: strong inflection");
    expect(html).toContain(`aria-expanded="false"`);
    expect(html).not.toContain(`aria-expanded="true"`);
    expect(html).not.toContain("How the price drivers were found");
  });

  it("gives each week ONE verdict: a fact only for a fundamental or market week, never beside « unknown »", () => {
    expect(arrows.map((a) => [a.week, a.fact])).toEqual([
      ["fundamental", "Management said Lunar New Year bookings were full."],
      ["market", "Hong Kong stocks rebounded after the tariff selloff."],
      ["unknown", null],
    ]);
    expect(html).toContain("1 fundamental, 1 market, 1 unknown");
    expect(html).toContain("1 of 3 weeks");
    expect(html).toContain(NO_ITEM_EXPLAINS);
    expect(html).not.toContain("The property news items do not explain it.");
  });

  it("labels a policy or industry candidate « read in events », steps 1 to 5 and the industry news counted", () => {
    expect(html).toContain("Industry · Read in events");
    expect(html).toContain("2, 1 on its industry");
    for (const t of ["1 · Price movement", "2 · Events", "3 · Which event explains which week", "4 · Fundamental or not", "5 · Price Driver Candidates"]) expect(html).toContain(t);
  });

  it("a candidate's confidence: the level on top, then tests A, B and C, a change in a market week never counted as followed", () => {
    const one = renderToStaticMarkup(createElement(ConfidenceBody, { symbol: S, k: kpis[0], arrows }));
    expect(one.indexOf("Commercial rent levels reason.")).toBeLessThan(one.indexOf("A · Each big change"));
    // The level sits in the drawer title only, never twice.
    expect(one).not.toContain("Noise");
    expect(one).toContain("0 of 1");
    expect(one).toContain("in 0 of 1 fundamental week");
    expect(one).toContain("Did not follow");
    expect(one).toContain("C · Both moved");
  });

  it("words a reversal from what the judge stored: its own direction, and the turn against the narrative; never from `expected`", () => {
    expect(reversalWord(kpis[1].reversal)).toEqual({ word: "Strong inflection", variant: "success" });
    // The same driver with the price expected to go the other way reads the same: `expected` plays no part.
    expect(reversalWord({ ...kpis[1].reversal!, side: "short", turn: "crack", strength: "weak" })).toEqual({ word: "Weak crack", variant: "warning" });
    expect(reversalWord(kpis[2].reversal).word).toBe("With the story");
    expect(reversalWord({ ...kpis[2].reversal!, stance: "none" }).word).toBe("No reversal");
    expect(reversalWord(null).word).toBe("Not assessed yet");
    // A reading stored before the narrative step (v1: no stance) is said so, never guessed.
    expect(reversalWord({ intrinsic: { state: "reversing", period: null, why: "w" }, leading: { probability: "none", why: "w", events: [] }, strength: "strong", direction: "up", why: "w" }).word).toBe("Not read against the narrative yet");
    const up = renderToStaticMarkup(createElement(ReversalBody, { symbol: S, k: kpis[1] }));
    expect(up).toContain("Reversing up");
    // Whether it lasts, how big, how much is priced in: small badges beside the bottom line.
    for (const t of ["Structural", "Net income: HK$32M to HK$60M (+88%) · Material", "Partly in the price"]) expect(up).toContain(t);
    // The quote itself opens its page (one click on the quote).
    expect(up).toContain(encodeURIComponent("doc:d1:3:bookings for the Lunar New Year were full"));
    expect(up).toContain("« bookings for the Lunar New Year were full »");
    const down = renderToStaticMarkup(createElement(ReversalBody, { symbol: S, k: kpis[2] }));
    expect(down).toContain("Continuing to fall");
    expect(down).not.toContain("In the company");
    for (const [state, word] of [["continuing-to-rise", "Continuing to rise"], ["reversing-down", "Reversing down"], ["flat", "Flat"]] as const) {
      expect(renderToStaticMarkup(createElement(ReversalBody, { symbol: S, k: { ...kpis[1], reversal: { ...kpis[1].reversal!, intrinsic: { ...kpis[1].reversal!.intrinsic, state } } } }))).toContain(word);
    }
  });
});
