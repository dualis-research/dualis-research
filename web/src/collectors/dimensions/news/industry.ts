import { and, eq } from "drizzle-orm";
import { companyProfiles } from "@/db/schema/gold";
import { judgments } from "@/db/schema/silver";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { firstJsonObject } from "@/llm/judge";
import { fnv } from "../analysis/facts";

/**
 * Industry terms (DAILY-EMAIL-1123, Thierry 2026-11-23: an event = a news item on the ticker OR its industry; fundamental
 * = the company + its competitors, suppliers and any material trend in its space, never macro). Claude picks the Google
 * News search terms of a company's space ONCE per company profile, stored in silver.judgments (subject kind
 * `company-profile`, key `industry-terms@v1:<hash of the profile>`, the terms in `raw.terms`): a new profile asks again,
 * a run never does. Never a hand list.
 */
export const INDUSTRY_TERMS_QUESTION = "industry-terms@v1";
export const INDUSTRY_SUBJECT_KIND = "company-profile";
const MAX_TERMS = 4;

const SYSTEM = [
  "You pick Google News search terms that surface news about one listed company's INDUSTRY, for an equity analyst who already follows the company's own news.",
  "Pick 2 to 4 short exact phrases (1 to 4 words each): the names of its main listed or well-known competitors, a key supplier or customer it depends on, and the product or service market it sells in, in its main country when that narrows it (e.g. \"Hong Kong beauty salons\").",
  "Each phrase must be specific enough that most articles it returns concern this company's space. Never the company's own name, never a generic word alone (\"technology\", \"retail\"), never macro (oil price, interest rates, inflation, war, an index).",
  "Write each phrase in the language its news is written in (English unless the space is covered mostly in Korean, Japanese or Chinese).",
  'Answer with JSON only, no prose, no code fence: {"terms": ["...", "..."], "reason": "<one plain sentence: what the company does and why these terms cover its space>"}',
].join(" ");

type Profile = { name: string | null; country: string | null; sector: string | null; industry: string | null; description: string | null };

export function industryInput(symbol: string, p: Profile): string {
  return [
    `Company: ${p.name ?? symbol} (${symbol})`,
    p.country ? `Country: ${p.country}` : null,
    p.sector ? `Sector: ${p.sector}` : null,
    p.industry ? `Industry: ${p.industry}` : null,
    p.description ? `What it does: ${p.description}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseTerms(text: string): { terms: string[]; reason: string | null } {
  const obj = JSON.parse(firstJsonObject(text)) as { terms?: unknown; reason?: unknown };
  if (!Array.isArray(obj.terms)) throw new Error(`industry terms answer holds no "terms" list: ${text.slice(0, 200)}`);
  const terms = [...new Set(obj.terms.filter((t): t is string => typeof t === "string").map((t) => t.replace(/"/g, "").trim()).filter(Boolean))].slice(0, MAX_TERMS);
  if (terms.length === 0) throw new Error(`industry terms answer has an empty "terms" list: ${text.slice(0, 200)}`);
  return { terms, reason: typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : null };
}

/** The industry terms of one ticker: the stored judgment of its current profile, else ONE Claude call, stored. */
export async function industryTerms(db: Db, symbol: string, complete: Complete | undefined): Promise<string[]> {
  const [p] = await db
    .select({ name: companyProfiles.name, country: companyProfiles.country, sector: companyProfiles.sector, industry: companyProfiles.industry, description: companyProfiles.description })
    .from(companyProfiles)
    .where(eq(companyProfiles.symbol, symbol));
  if (!p?.name) throw new Error(`no company profile for ${symbol} yet, cannot pick its industry terms`);
  const input = industryInput(symbol, p);
  const questionKey = `${INDUSTRY_TERMS_QUESTION}:${fnv(input)}`;
  const key = and(eq(judgments.subjectKind, INDUSTRY_SUBJECT_KIND), eq(judgments.subjectId, symbol), eq(judgments.questionKey, questionKey));
  const [stored] = await db.select().from(judgments).where(key);
  if (stored) return (stored.raw as { terms: string[] }).terms;
  if (!complete) throw new Error(`industry terms for ${symbol} are not judged yet and this run has no LLM`);

  const { text, model } = await complete({ system: SYSTEM, prompt: input });
  const { terms, reason } = parseTerms(text);
  await db
    .insert(judgments)
    .values({
      subjectKind: INDUSTRY_SUBJECT_KIND,
      subjectId: symbol,
      questionKey,
      question: SYSTEM,
      verdict: "terms",
      probability: 1,
      citedSentence: null,
      reason,
      model,
      raw: { text, terms, input },
    })
    .onConflictDoNothing();
  const [row] = await db.select().from(judgments).where(key);
  return (row.raw as { terms: string[] }).terms;
}
