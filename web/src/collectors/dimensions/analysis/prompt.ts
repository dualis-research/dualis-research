import type { AnalysisAnswer, Strength, ThesisSide } from "@/db/schema/analysis";
import { firstJsonObject } from "@/llm/judge";
import { stripDashes } from "@/llm/dashes";

/**
 * Bump when the prompt changes meaning: every ticker is asked again. v12 (Kevin 2026-11-25, step C of
 * docs/architecture.md): does the market hold a narrative that explains why the stock sits below or above its fair
 * value, with what confidence (strong | weak | noise), and which Price Drivers explain it (one sentence each).
 */
export const ANALYSIS_VERSION = "analysis@v12";

/** Thierry's game, explained so the model can play it (never a coded rule). */
const METHOD = [
  "The analyst's method: he does not believe in one true value. The price reflects the market's NARRATIVE; the FAIR VALUE is what the business is worth if its plan works.",
  "The fair value is GIVEN in the facts (weighted from several valuation methods, with its range low to high, and how it moved over time): never compute another one.",
  "Your question: does the market hold a narrative that explains why the stock sits BELOW its fair value (side long = a PESSIMISTIC story; a Price Driver turning against it is an inflection, a buy) or ABOVE it (side short = an OPTIMISTIC story; a Price Driver breaking it is a crack, a sell)? And how confident are you that the market really holds it?",
  "confidence: strong = the price, the fair value and its range, and what the Price Drivers did while the price moved all tell the same clear story; weak = a story is there but thin (the price sits inside the fair value range, the Price Drivers disagree, the fair value lags a fact the price already shows); noise = no narrative explains the gap (the price sits at its fair value, or nothing given says why it is where it is). It is YOUR call, as the analyst would make it: no code decides it for you.",
].join(" ");

export const ANALYSIS_SYSTEM = [
  "You are the equity research associate of a small-cap long/short analyst. You write for him, in plain English, short sentences.",
  METHOD,
  "Every figure you write comes from the facts given; you never invent a number. No rating (buy/hold/sell), no % upside, no time horizon, no price target other than the fair value given. No em dash, no en dash.",
  "Answer with JSON only, no prose, no code fence.",
].join(" ");

/** The previous version of the narrative, kept word for word unless the facts changed what the market believes. */
export type PreviousThesis = { side?: ThesisSide; sideWhy?: string | null; confidence?: Strength | null; narrative: string; narrativeDetail?: string | null; beliefs: { priceDriver: string | null; belief: string }[] };

/**
 * The one call of step C: `priceDrivers` = the block of Price Drivers (labelled P1..), the ONLY reasons the narrative may
 * rest on; `labels` = those labels. The facts carry the price, the fair value and its range, and Thierry's notes.
 */
export function analysisPrompt(factsText: string, priceDrivers: string, labels: string[], previous: PreviousThesis | null = null): string {
  return [
    "Facts (all from the collected data):",
    factsText,
    "",
    priceDrivers,
    "",
    ...(previous
      ? [
          "Your previous answer:",
          JSON.stringify(previous, null, 1),
          "Keep it WORD FOR WORD (same side, same confidence, same narrative, same beliefs) unless the facts above changed what the market believes, a Price Driver was added or dropped, or a sentence breaks the method. Whether a Price Driver is turning is read separately, after you: never a reason to rewrite.",
          "",
        ]
      : []),
    "Answer as JSON:",
    "{",
    '  "side": "long" | "short",',
    '  "sideWhy": "<ONE sentence: the stock sits below (long) or above (short) its fair value, with the price against the fair value and its range>",',
    '  "confidence": "strong" | "weak" | "noise",',
    '  "narrative": "<ONE short plain sentence, subject verb complement: the story the market tells about the company that explains where the stock sits, at most one figure, e.g. The market sees Kyungbang as a dying textile maker. When confidence is noise: one sentence saying no clear story explains it>",',
    '  "narrativeDetail": "<2 to 4 sentences: why you think the market holds this story and how sure you are, on which Price Drivers, where the price sits versus the fair value and its range, with the figures>",',
    `  "beliefs": [ when confidence is weak or strong, one per Price Driver that EXPLAINS the narrative (among ${labels.join(", ")}; at least one): {"priceDriver": "<its label, e.g. P1>", "belief": "<ONE short plain sentence, no label: what the market believes about this Price Driver today, e.g. the market doubts profit will hold>"}; [] when confidence is noise ]`,
    "}",
    "The side and the confidence are YOUR call, as the analyst would make them: read where the price sits against the fair value (base, low, high), how both moved over time, what the Price Drivers did while the price moved, and the analyst's own notes when given (his view is an input you weigh, never an order).",
    "The story rests ONLY on the Price Drivers listed above: never add a reason of your own. Name the ones that explain it, leave out one that plays no part. A Price Driver whose latest figures already go against the story still gets its belief: what the market assumes about it; whether it is turning is judged separately, after you.",
    "A weak-confidence Price Driver carries less of the story than a strong one.",
    "Debt is read against the earnings that service it (net debt / EBITDA, interest cover in the facts), never against the market cap.",
  ].join("\n");
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export const CONFIDENCES: readonly Strength[] = ["strong", "weak", "noise"];

/**
 * The model's answer, typed. Shape errors fail loud (the fetch fails, the Data page shows it, the next run asks again).
 * `labels` = the Price Driver labels of the prompt and the id each stands for: a belief naming an unknown label is
 * dropped (never guessed), a label named twice keeps its first. A weak or strong narrative that names no Price Driver
 * is a shape error; a noise one carries no belief.
 */
export function parseAnalysis(text: string, labels: Map<string, string>): AnalysisAnswer {
  const o = JSON.parse(firstJsonObject(text)) as Record<string, unknown>;
  if (o.side !== "long" && o.side !== "short") throw new Error(`analysis: side "${String(o.side)}" is not long or short`);
  if (!CONFIDENCES.includes(o.confidence as Strength)) throw new Error(`analysis: confidence "${String(o.confidence)}" is not strong, weak or noise`);
  const confidence = o.confidence as Strength;
  if (!isStr(o.narrative)) throw new Error("analysis: no narrative");
  const seen = new Set<string>();
  const beliefs =
    confidence === "noise"
      ? []
      : (Array.isArray(o.beliefs) ? (o.beliefs as Record<string, unknown>[]) : []).flatMap((b) => {
          const kpiDriverId = labels.get(String(b.priceDriver ?? "").trim());
          if (!kpiDriverId || seen.has(kpiDriverId) || !isStr(b.belief)) return [];
          seen.add(kpiDriverId);
          return [{ kpiDriverId, belief: stripDashes(b.belief.trim()) }];
        });
  if (confidence !== "noise" && beliefs.length === 0) throw new Error("analysis: a weak or strong narrative names no Price Driver of the list");
  return { side: o.side, sideWhy: isStr(o.sideWhy) ? stripDashes(o.sideWhy) : null, confidence, narrative: stripDashes(o.narrative), narrativeDetail: isStr(o.narrativeDetail) ? stripDashes(o.narrativeDetail) : null, beliefs };
}

/** The beliefs of a stored answer (one sentence per Price Driver that explains the narrative). */
export function beliefsOf(a: AnalysisAnswer): { kpiDriverId: string; belief: string }[] {
  return a.beliefs ?? [];
}

/** Does step D run on this narrative? Only when step C's confidence is weak or strong (docs/architecture.md). */
export const holdsNarrative = (n: { confidence?: Strength | null } | null | undefined): boolean => n?.confidence === "strong" || n?.confidence === "weak";
