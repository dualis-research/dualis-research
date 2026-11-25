/** A signal in words: "Weak BUY", "Strong SELL", "no signal" (Kevin 2026-11-25: « Strong BUY » reads clearer than « strong inflection »). */
export function signalWords(signal: string, strength: string): string {
  return signal === "none" ? "no signal" : `${strength === "strong" ? "Strong" : "Weak"} ${signal}`;
}

/** Price vs Thierry's own fair value: above or below, by how much. Never an AI number. */
export function gapOf(price: number | null, fairValue: number | null): { pct: number; side: "below" | "above" } | null {
  if (price === null || fairValue === null || !(price > 0) || !(fairValue > 0)) return null;
  const pct = (price - fairValue) / fairValue;
  return { pct: Math.abs(pct), side: pct < 0 ? "below" : "above" };
}

/** The call a signal makes (gold.signals): BUY only below the fair value, SELL only above it (docs/thierry-method.md). */
export type SignalCall = "BUY" | "SELL";

export type SignalStrength = "strong" | "weak" | "noise";
export const STRENGTH_WORD: Record<SignalStrength, string> = { strong: "Strong", weak: "Weak", noise: "Noise" };

/** A position's return: the sign flips on a short. */
export function positionReturn(entry: number | null, current: number | null, direction: string | null): number | null {
  if (entry === null || current === null || !(entry > 0) || (direction !== "long" && direction !== "short")) return null;
  const r = current / entry - 1;
  return direction === "short" ? -r : r;
}

/**
 * A narrative tag (Kevin 2026-11-25: « Strong BUY », « Weak SELL », never « inflection » / « crack »): stored as
 * reversal / continuation / noise; a reversal of a pessimistic (long) story reads BUY, of an optimistic (short) one
 * SELL. The narrative decides the word, never where the price sits.
 */
export function tagWord(effect: string, strength: string, side: "long" | "short" | null): string {
  if (effect === "too-old") return "Too old";
  if (effect === "noise" || strength === "noise") return "Noise";
  const s = strength === "strong" ? "Strong" : "Weak";
  if (effect === "continuation") return `${s} continuation`;
  return `${s} ${side === null ? "reversal" : side === "long" ? "BUY" : "SELL"}`;
}

/** How much of a turn the price already moved, in plain words (console Status column and the alert image). */
export const PRICED_WORD: Record<string, string> = { none: "Not in the price yet", partly: "Partly in the price", fully: "Already in the price" };
