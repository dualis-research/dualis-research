import { and, eq } from "drizzle-orm";
import { readFacts } from "@/bsg/facts";
import { companyProfiles } from "@/db/schema/gold";
import * as silver from "@/db/schema/silver";
import { judgments } from "@/db/schema/silver";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { firstJsonObject } from "@/llm/judge";
import { fnv } from "../analysis/facts";
import { PROFILE_DIMENSION } from "../company-profile/gold";
import { industryInput } from "./industry";

/**
 * Local-press terms (NEWS-HISTORY-1123): a Hong Kong, Japanese or Korean small cap is written about in its home
 * language, under a name the English press never prints (1161.HK: Google News holds 0-1 English article per half year
 * on « Water Oasis Group », its Chinese name « 奧思集團 » carries the 2024-05 profit warning).
 * - names = the company's Wikidata labels in its market's language (company-profile fact `localNames`), never Claude's
 *   memory: asked from memory, Claude named Water Oasis « 水月之家 » (2026-11-23).
 * - industry = 2-4 phrases of its space in that language, Claude, ONCE per profile + local name (silver.judgments,
 *   subject kind `company-profile`, key `news-local-terms@v2:<hash>`, `raw.industry`).
 * A market whose press writes in English has no local terms and asks nothing.
 */
export const LOCAL_TERMS_QUESTION = "news-local-terms@v2";
const SUBJECT_KIND = "company-profile";
const MAX_INDUSTRY = 4;

/** Home-press language per market, in Wikidata label order of preference. */
const MARKET_LANGS: Record<string, { name: string; labels: string[] }> = {
  HK: { name: "traditional Chinese, as the Hong Kong press writes", labels: ["zh-hk", "zh-hant", "zh-tw", "zh"] },
  TW: { name: "traditional Chinese", labels: ["zh-tw", "zh-hant", "zh"] },
  CN: { name: "simplified Chinese", labels: ["zh-hans", "zh-cn", "zh"] },
  JP: { name: "Japanese", labels: ["ja"] },
  KR: { name: "Korean", labels: ["ko"] },
};

const SYSTEM = (language: string) =>
  [
    `You give Google News search phrases in ${language} about one listed company's INDUSTRY, for an equity analyst who reads its home press.`,
    "Pick 2 to 4 short exact phrases, written as that press prints them: the names of its main local competitors (listed or well known), a key supplier or customer, its product market in its country.",
    "Never the company's own name, never a generic word alone, never macro (oil, rates, inflation, war, an index).",
    'Answer with JSON only, no prose, no code fence: {"industry": ["..."], "reason": "<one plain sentence>"}',
  ].join(" ");

export type LocalTerms = { names: string[]; industry: string[] };

export function parseLocalIndustry(text: string): { industry: string[]; reason: string | null } {
  const obj = JSON.parse(firstJsonObject(text)) as { industry?: unknown; reason?: unknown };
  if (!Array.isArray(obj.industry)) throw new Error(`local terms answer holds no "industry" list: ${text.slice(0, 200)}`);
  const industry = [...new Set(obj.industry.filter((t): t is string => typeof t === "string").map((t) => t.replace(/"/g, "").trim()).filter(Boolean))].slice(0, MAX_INDUSTRY);
  return { industry, reason: typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : null };
}

/** The Wikidata labels of a ticker in its market's language, best label first. */
export async function localNames(db: Db, symbol: string, market: string): Promise<string[]> {
  const lang = MARKET_LANGS[market];
  if (!lang) return [];
  const facts = (await readFacts(db, PROFILE_DIMENSION, [symbol])).get(symbol)?.get("localNames") ?? [];
  const out: string[] = [];
  for (const code of lang.labels) for (const f of facts) for (const n of (f.value as Record<string, string[]>)[code] ?? []) if (!out.includes(n)) out.push(n);
  return out.slice(0, 2);
}

/** The local-press terms of one ticker: Wikidata names + the stored industry judgment, else ONE Claude call, stored. */
export async function localTerms(db: Db, symbol: string, complete: Complete | undefined): Promise<LocalTerms> {
  const [[p], [t]] = await Promise.all([
    db
      .select({ name: companyProfiles.name, country: companyProfiles.country, sector: companyProfiles.sector, industry: companyProfiles.industry, description: companyProfiles.description })
      .from(companyProfiles)
      .where(eq(companyProfiles.symbol, symbol)),
    db.select({ market: silver.tickers.market }).from(silver.tickers).where(eq(silver.tickers.symbol, symbol)),
  ]);
  if (!p?.name) throw new Error(`no company profile for ${symbol} yet, cannot pick its local-press terms`);
  const lang = t ? MARKET_LANGS[t.market] : undefined;
  if (!t || !lang) return { names: [], industry: [] };
  const names = await localNames(db, symbol, t.market);

  const input = [industryInput(symbol, p), names.length ? `Its name in the home press: ${names.join(", ")}` : null].filter(Boolean).join("\n");
  const questionKey = `${LOCAL_TERMS_QUESTION}:${fnv(input)}`;
  const key = and(eq(judgments.subjectKind, SUBJECT_KIND), eq(judgments.subjectId, symbol), eq(judgments.questionKey, questionKey));
  const [stored] = await db.select().from(judgments).where(key);
  if (stored) return { names, industry: (stored.raw as { industry: string[] }).industry };
  if (!complete) throw new Error(`local-press industry terms for ${symbol} are not judged yet and this run has no LLM`);

  const system = SYSTEM(lang.name);
  const { text, model } = await complete({ system, prompt: input });
  const { industry, reason } = parseLocalIndustry(text);
  await db
    .insert(judgments)
    .values({ subjectKind: SUBJECT_KIND, subjectId: symbol, questionKey, question: system, verdict: "terms", probability: 1, citedSentence: null, reason, model, raw: { text, industry, input } })
    .onConflictDoNothing();
  const [row] = await db.select().from(judgments).where(key);
  return { names, industry: (row.raw as { industry: string[] }).industry };
}
