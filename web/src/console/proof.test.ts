import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GoldDriverEvent, GoldKpiDriver, KpiEventRow } from "@/db/schema/analysis";
import { moveArrows, NO_EVENT } from "./move-arrows";

vi.mock("@/console/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => createElement("a", { href, className }, children) }));
vi.mock("@/console/moves-chart", () => ({ MovesChart: () => createElement("div", null, "chart") }));
vi.mock("@/console/story-chart", async (orig) => ({ ...(await orig<typeof import("./story-chart")>()), StoryChart: () => createElement("div", null, "story chart") }));
vi.mock("@/console/driver-steps-charts", () => ({ EventsTimeline: () => createElement("div", null, "timeline") }));
vi.mock("@/console/kpi-queries", () => ({ proofData: async () => null }));

/** The pages show steps A to E of docs/architecture.md in order, closed, each title carrying its conclusion, and nothing else. */

const S = "1161.HK";
const move = (id: string, startDay: string, direction: "up" | "down") => ({ id, startDay, endDay: startDay, direction, abnormal: direction === "up" ? 0.11 : -0.09, bench: "Hang Seng" });
const event = (id: string, kind: GoldDriverEvent["kind"], day: string, title: string, moveId: string | null): GoldDriverEvent => ({ id: `${S}|${kind}:${id}`, symbol: S, kind, sourceId: id, day, title, url: "https://example.com/" + id, stock: 0.1, benchReturn: 0, beta: 1, reaction: 0.1, z: 2.5, bench: "Hang Seng", moveId, rebuiltAt: new Date() });
const events = [event("n1", "news", "2025-01-14", "Lunar New Year bookings full", "w1"), event("n2", "news", "2025-04-09", "Hong Kong retail sector under pressure", "w2")];
const arrows = moveArrows([move("w1", "2025-01-08", "up"), move("w2", "2025-04-08", "down"), move("w3", "2026-08-06", "up")], events);
const row = (e: GoldDriverEvent, kpiMoved: boolean | null, priceMoved: boolean, result: KpiEventRow["result"]): KpiEventRow => ({ eventId: e.id, day: e.day, kind: e.kind, title: e.title, sourceId: e.sourceId, url: e.url, period: null, from: null, to: null, change: null, kpiWhy: kpiMoved ? "rents rose" : null, kpiMoved, stock: e.stock, reaction: e.reaction, z: e.z, moveId: e.moveId, priceMoved, result, cite: null, changeUp: kpiMoved ? true : null });
const tests = { changes: 1, followed: 1, against: 0, moves: 3, explained: 1, explainedMoveIds: ["w2"] };
const kpi = (rank: number, name: string, kind: GoldKpiDriver["kind"], level: GoldKpiDriver["level"], over: Partial<GoldKpiDriver> = {}): GoldKpiDriver =>
  ({ id: `${S}:kpi:${rank}`, symbol: S, rank, name, kind, foundIn: [], tests, why: "w", expected: "up", series: null, approximation: null, measure: null, periods: [], level, reason: `${name} reason.`, rows: [], confirmed: 0, invalidated: 0, signal: null, signalWhy: null, marketBelief: null, reversal: null, direction: null, asOf: new Date(), rebuiltAt: new Date(), ...over }) as GoldKpiDriver;
const kpis = [
  kpi(1, "Commercial rent levels", "industry", "none", { rows: [row(events[1], true, true, "confirms")], foundIn: [events[1].id] }),
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
  // A weak driver the judge reads in weak CONTINUATION of the story, its own figure still falling; the narrative does not rest on it.
  kpi(3, "Hong Kong revenue", "kpi", "weak", { reversal: { intrinsic: { state: "continuing-to-fall", period: null, why: "Revenue fell again." }, leading: { probability: "none", why: "Nothing recent.", events: [] }, strength: "weak", direction: "down", why: "Revenue keeps falling, as the market assumes.", side: "long", stance: "with", turn: null } }),
];
const narrative = { side: "long" as const, confidence: "strong" as const, text: "The market prices Water Oasis as a flat, mature chain.", detail: "Profit halved while rents rose.", sideWhy: "The price sits a third under the fair value while profit halved.", beliefs: [{ id: `${S}:kpi:2`, name: "Net income", belief: "The market assumes profit stays stuck after the rent shock." }] };
const signal = { signal: "BUY" as const, strength: "strong" as const, why: "Net income is turning up: profit nearly doubled.", evidenceIds: [events[0].id], since: new Date("2026-11-20T00:00:00Z") };
const data = { events, arrows, kpis, narrative, signal, chart: { price: [], beta: 1, indexName: "Hang Seng", windowEnd: (d: string) => d }, industryNews: new Set(["n2"]), reversalSince: new Map<string, Date | null>(), story: [{ id: `${S}:2024-05-13`, startDay: "2024-05-13", endDay: "2024-06-03", cause: "company" as const, title: "Profit warning on mainland stores", returnPct: -0.3, bench: "Hang Seng", benchReturn: -0.01 }] };

describe("the analysis of a stock on screen: steps A to E", async () => {
  const { ProofView, ConfidenceBody, ReversalBody } = await import("./proof");
  const { reversalWord } = await import("@/content/reversal-words");
  const html = renderToStaticMarkup(createElement(ProofView, { symbol: S, data }));

  it("shows A, B, C, D, E in order, each title with its conclusion, all closed, and no other analysis section", () => {
    const at = (t: string) => html.indexOf(t);
    const order = ["A · Price Driver Candidates", "B · Price Drivers", "C · Narrative", "D · Reversals", "E · Signal"];
    for (const t of order) expect(at(t)).toBeGreaterThan(-1);
    for (let i = 1; i < order.length; i++) expect(at(order[i - 1])).toBeLessThan(at(order[i]));
    // Each title carries its conclusion.
    expect(html).toContain("3 found");
    expect(html).toContain("1 strong, 1 weak, 1 noise");
    expect(html).toContain("Pessimistic, strong confidence: ");
    expect(html).toContain("The market prices Water Oasis as a flat, mature chain.");
    expect(html).toContain("Net income: Strong BUY");
    expect(html).toContain("Narrative turning: strong");
    expect(html).toContain(`aria-expanded="false"`);
    expect(html).not.toContain(`aria-expanded="true"`);
    // Nothing of the older designs.
    for (const gone of ["Fundamental or not", "Fundamental week", "Market week", "Unknown cause", "1 · ", "2 · Confidence", "Business economics", "No news or filing explains it"]) expect(html).not.toContain(gone);
  });

  it("A: the events (industry news counted), the significant unbiased moves, the events of each move, the candidates; no verdict on a move", () => {
    expect(html).toContain("2 events · 1 industry news, 1 company news");
    for (const t of ["Events", "Significant unbiased 1-week moves", "Events of each significant move", "Candidates read in those events"]) expect(html).toContain(t);
    expect(html).toContain("3 moves");
    expect(html).toContain("2 of 3 moves with an event");
    // An industry news is a valid event of its move, shown as such; a move with no stored event says so.
    expect(html).toContain("Industry: ");
    expect(html).toContain("Hong Kong retail sector under pressure");
    expect(html).toContain(NO_EVENT);
    expect(html).toContain("Industry · Read in events · read in 1 event of a significant move");
    expect(arrows[0]).not.toHaveProperty("week");
  });

  it("B: a candidate's sentence on top, then the two tests, on every significant move", () => {
    const one = renderToStaticMarkup(createElement(ConfidenceBody, { symbol: S, k: kpis[0], arrows }));
    expect(one.indexOf("Commercial rent levels reason.")).toBeLessThan(one.indexOf(`Each big change in ${kpis[0].name}: did the stock make a significant move (market removed) the week after?`));
    // The level sits in the drawer title only, never twice.
    expect(one).not.toContain("Noise");
    expect(one).toContain("1 of 1");
    expect(one).toContain(`Each significant 1-week stock move (market removed): did ${kpis[0].name} change on its first day?`);
    expect(one).toContain("1 of 3");
    expect(one).toContain("Followed");
    expect(one).toContain("significant move 2");
    expect(one).not.toMatch(/fundamental|Market week|C · /);
  });

  it("C: the side, the confidence, the why, and each Price Driver that explains it under its REAL name with its belief", () => {
    expect(html).toContain("The price sits a third under the fair value while profit halved.");
    expect(html).toContain("Profit halved while rents rose.");
    expect(html).toContain("The market assumes profit stays stuck after the rent shock.");
    expect(html).toContain(encodeURIComponent(`kdriver:${S}:kpi:2`));
    // A noise narrative: said in the title, and steps D and E are not read.
    const noise = renderToStaticMarkup(createElement(ProofView, { symbol: S, data: { ...data, narrative: { ...narrative, confidence: "noise" as const, beliefs: [] } } }));
    expect(noise).toContain("Pessimistic, noise: ");
    expect(noise).toContain("Not read: the narrative is noise");
    expect(noise).toContain("E · Signal");
    expect(noise).not.toContain("Narrative turning:");
  });

  it("D: continuation (weak | strong), reversal (weak | strong) or noise, worded from what the judge stored, never from `expected`", () => {
    expect(reversalWord(kpis[1].reversal)).toEqual({ word: "Strong BUY", variant: "success" });
    // The same driver with the price expected to go the other way reads the same: `expected` plays no part.
    expect(reversalWord({ ...kpis[1].reversal!, side: "short", turn: "crack", strength: "weak" })).toEqual({ word: "Weak SELL", variant: "warning" });
    expect(reversalWord(kpis[2].reversal).word).toBe("Weak continuation");
    expect(reversalWord({ ...kpis[2].reversal!, strength: "strong" }).word).toBe("Strong continuation");
    expect(reversalWord({ ...kpis[2].reversal!, stance: "none", strength: "none" }).word).toBe("Noise");
    expect(reversalWord(null).word).toBe("Not assessed yet");
    // A reading stored before the narrative step (v1: no stance) is said so, never guessed.
    expect(reversalWord({ intrinsic: { state: "reversing", period: null, why: "w" }, leading: { probability: "none", why: "w", events: [] }, strength: "strong", direction: "up", why: "w" }).word).toBe("Not read against the narrative yet");
    expect(html).toContain("Weak continuation");
    const up = renderToStaticMarkup(createElement(ReversalBody, { symbol: S, k: kpis[1] }));
    expect(up).toContain("Reversing up");
    // The leading indicator (agreed addition), its event one click from its source.
    expect(up).toContain("High chance it turns soon");
    expect(up).toContain("Lunar New Year bookings full");
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

  it("panel: the 10 newest events and the Price Drivers only, each list whole on the Analysis page", async () => {
    const { PANEL_EVENTS } = await import("./proof");
    const many = Array.from({ length: PANEL_EVENTS + 3 }, (_, i) => ({ ...events[0], id: `e${i}`, day: `2026-10-${String(i + 1).padStart(2, "0")}`, title: `Event number ${i}` }));
    const panel = renderToStaticMarkup(createElement(ProofView, { symbol: S, data: { ...data, events: many }, panel: true }));
    expect(panel).toContain(`See all ${many.length} events ›`);
    expect(panel).toContain(`/tickers/${encodeURIComponent(S)}#events`);
    expect(panel).not.toContain("Event number 0<");
    expect(panel).toContain("Event number 12");
    const noise = kpis.filter((k) => k.level !== "strong" && k.level !== "weak").length;
    if (noise) expect(panel).toContain(`#price-drivers`);
    const page = renderToStaticMarkup(createElement(ProofView, { symbol: S, data: { ...data, events: many } }));
    expect(page).toContain("Event number 0");
    expect(page).not.toContain("See all");
  });

  it("E: the judge's sentence, the call, and the events behind it", () => {
    const e = html.slice(html.indexOf("E · Signal"));
    expect(e).toContain("BUY");
    expect(e).toContain("Net income is turning up: profit nearly doubled.");
    expect(e).toContain("Lunar New Year bookings full");
    const none = renderToStaticMarkup(createElement(ProofView, { symbol: S, data: { ...data, signal: { signal: "none" as const, strength: "noise" as const, why: "One good half does not turn the story.", evidenceIds: [], since: new Date("2026-11-20T00:00:00Z") } } }));
    expect(none).toContain("Narrative turning: noise");
    expect(none).toContain("One good half does not turn the story.");
  });
});

describe("step F, the story of the stock, last (Thierry 2026-11-26)", async () => {
  const { ProofView } = await import("./proof");
  it("closes the analysis with its episodes, each title in words", () => {
    const html = renderToStaticMarkup(createElement(ProofView, { symbol: S, data }));
    expect(html.indexOf("F · Stock story")).toBeGreaterThan(html.indexOf("E · Signal"));
    expect(html).toContain("1 episode");
    expect(html).toContain("Profit warning on mainland stores");
    expect(html).toContain(`?item=${encodeURIComponent(`story:${S}:2024-05-13`)}`);
  });
  it("says so when the story is not told yet", () => {
    const html = renderToStaticMarkup(createElement(ProofView, { symbol: S, data: { ...data, story: [] } }));
    expect(html).toContain("Not told yet");
  });
});
