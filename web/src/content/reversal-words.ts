import type { DriverReversal, Strength } from "@/db/schema/analysis";

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

/** Does the judge read the driver as turning against the narrative, at a strength that counts? */
export const turnsAgainst = (r: DriverReversal | null | undefined): boolean => !!r && r.stance === "against" && (r.strength === "strong" || r.strength === "weak");

/**
 * The bottom line: « Strong inflection », « Weak crack » (a turn against a pessimistic / an optimistic narrative),
 * « With the story » when the judge says it strengthens it, else « No reversal ». A reading made before the narrative
 * step (no stance) is « Not read against the narrative yet ».
 */
export function reversalWord(r: DriverReversal | null | undefined): { word: string; variant: "success" | "warning" | "neutral" } {
  if (!r) return { word: "Not assessed yet", variant: "neutral" };
  if (r.stance === undefined) return { word: "Not read against the narrative yet", variant: "neutral" };
  if (turnsAgainst(r)) return { word: `${r.strength === "strong" ? "Strong" : "Weak"} ${r.turn ?? (r.side === "short" ? "crack" : "inflection")}`, variant: r.strength === "strong" ? "success" : "warning" };
  return { word: r.stance === "with" ? "With the story" : "No reversal", variant: "neutral" };
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
