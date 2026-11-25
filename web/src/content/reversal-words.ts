import type { DriverReversal, GoldKpiDriver, Strength } from "@/db/schema/analysis";

/**
 * A Price Driver's reversal in words (Kevin 2026-11-24). Pure: the collectors, the pictures and the console share it.
 * The words come from what the judge stored (`kpi-reversal`): its state, and whether the turn goes against the
 * narrative; never computed from the direction the price « should » take.
 */

/** The driver's own direction on its latest value. `reversing` / `continuing` = readings made before the five states. */
export const STATE_WORD: Record<DriverReversal["intrinsic"]["state"], string> = {
  "continuing-to-rise": "Continuing to rise",
  "continuing-to-fall": "Continuing to fall",
  "reversing-up": "Reversing up",
  "reversing-down": "Reversing down",
  flat: "Flat",
  reversing: "Reversing",
  continuing: "Continuing",
};

/** Does step D read the driver in reversal against the narrative (weak or strong)? */
export const turnsAgainst = (r: DriverReversal | null | undefined): boolean => !!r && r.stance === "against" && (r.strength === "strong" || r.strength === "weak");

/**
 * Step D's bottom line: « Strong BUY », « Weak SELL » (a reversal against a pessimistic / an optimistic narrative,
 * Kevin 2026-11-25), « Strong continuation », « Weak continuation » (the story gets stronger), else « Noise ». A reading made
 * before the narrative step (no stance) is « Not read against the narrative yet ».
 */
export function reversalWord(r: DriverReversal | null | undefined): { word: string; variant: "success" | "warning" | "neutral" } {
  if (!r) return { word: "Not assessed yet", variant: "neutral" };
  if (r.stance === undefined) return { word: "Not read against the narrative yet", variant: "neutral" };
  const strong = r.strength === "strong" ? "Strong" : "Weak";
  if (turnsAgainst(r)) return { word: `${strong} ${(r.turn ?? (r.side === "short" ? "crack" : "inflection")) === "crack" ? "SELL" : "BUY"}`, variant: r.strength === "strong" ? "success" : "warning" };
  if (r.stance === "with") return { word: r.strength === "none" ? "Continuation" : `${strong} continuation`, variant: "neutral" };
  return { word: "Noise", variant: "neutral" };
}

/** How many of a driver's latest periods or changes step D reads (`kpi-reversal` `ownLines`). */
export const READ_LATEST = 8;

/**
 * The events step D's reading of a Price Driver read (`gold.driver_events` ids): those that disclosed one of its latest
 * significant changes, and those its reading cites as a leading indicator. What an output shows beside an event.
 */
export function readEventIds(k: Pick<GoldKpiDriver, "periods" | "rows" | "measure" | "reversal">): Set<string> {
  const changes = k.measure
    ? k.periods.slice(-READ_LATEST).filter((p) => p.significant && p.releaseId).map((p) => p.releaseId!)
    : k.rows.filter((r) => r.kpiMoved === true).slice(-READ_LATEST).map((r) => r.eventId);
  return new Set([...changes, ...(k.reversal?.leading.events ?? []).map((e) => e.id)]);
}

/** The same bottom line as a narrative tag (pictures and tables that draw `tagWord`): a turn against the story, else noise. */
export function reversalTag(r: DriverReversal | null | undefined): { effect: "reversal" | "noise"; strength: Strength } {
  return r && turnsAgainst(r) ? { effect: "reversal", strength: r.strength as Strength } : { effect: "noise", strength: "noise" };
}

/** The reality line of a picture: the judge's headline, else its figure from → to. */
export function reversalHeadline(r: DriverReversal | null | undefined): string | null {
  if (!r) return null;
  const m = r.magnitude;
  return r.headline ?? (m ? `${m.figure}${m.from && m.to ? `: ${m.from} to ${m.to}` : ""}${m.change ? ` (${m.change})` : ""}` : null);
}
