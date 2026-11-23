import { and, eq } from "drizzle-orm";
import { companyProfiles } from "@/db/schema/gold";
import * as silver from "@/db/schema/silver";
import { judgments } from "@/db/schema/silver";
import type { Db } from "@/db/types";
import type { Complete } from "@/llm/complete";
import { firstJsonObject } from "@/llm/judge";
import { fnv } from "../analysis/facts";
import { industryInput } from "./industry";

/**
 * Local-press terms (NEWS-HISTORY-1123): a Hong Kong, Japanese or Korean small cap is written about in its home
 * language, under a name the English press never prints (1161.HK: Google News holds 0-1 English article per half year
 * on « Water Oasis Group », its Chinese name « 奧思集團 » carries the 2024-05 profit warning). Claude gives, ONCE per
 * company profile + market, the company's name(s) as its home press writes them and 2-4 phrases of its industry in
 * that language (silver.judgments, subject kind `company-profile`, key `news-local-terms@v1:<hash>`, `raw.names`,
 * `raw.industry`); both lists are empty when the home press writes in English. Never a hand list.
 */
export const LOCAL_TERMS_QUESTION = "news-local-terms@v1";
const SUBJECT_KIND = "company-profile";
const MAX_NAMES = 2;
const MAX_INDUSTRY = 4;

const SYSTEM = [
  "You give Google News search terms in the HOME-PRESS language of one listed company, for an equity analyst who reads its local news.",
  "names: the 1 or 2 names the company's home press writes it under, in that language and script exactly as printed (e.g. the Chinese name of a Hong Kong listing in traditional characters, the Japanese name of a Tokyo listing, the Korean name of a Seoul listing). Only names you are sure of; never a translation you made up.",
  "industry: 2 to 4 short exact phrases in that language naming its space: its main local competitors, a key supplier or customer, its product market in its country. Never the company's own name, never macro (oil, rates, inflation, war, an index).",
  "When the home press of the company writes in English (US, UK, Canada, Australia listings), answer empty lists.",
  'Answer with JSON only, no prose, no code fence: {"language": "<BCP 47 tag or null>", "names": ["..."], "industry": ["..."], "reason": "<one plain sentence>"}',
].join(" ");

export type LocalTerms = { names: string[]; industry: string[] };

const clean = (list: unknown, max: number) =>
  Array.isArray(list) ? [...new Set(list.filter((t): t is string => typeof t === "string").map((t) => t.replace(/"/g, "").trim()).filter(Boolean))].slice(0, max) : null;

export function parseLocalTerms(text: string): LocalTerms & { reason: string | null } {
  const obj = JSON.parse(firstJsonObject(text)) as { names?: unknown; industry?: unknown; reason?: unknown };
  const names = clean(obj.names, MAX_NAMES);
  const industry = clean(obj.industry, MAX_INDUSTRY);
  if (!names || !industry) throw new Error(`local terms answer lacks a "names" or "industry" list: ${text.slice(0, 200)}`);
  return { names, industry, reason: typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : null };
}

/** The local-press terms of one ticker: the stored judgment of its current profile, else ONE Claude call, stored. */
export async function localTerms(db: Db, symbol: string, complete: Complete | undefined): Promise<LocalTerms> {
  const [[p], [t]] = await Promise.all([
    db
      .select({ name: companyProfiles.name, country: companyProfiles.country, sector: companyProfiles.sector, industry: companyProfiles.industry, description: companyProfiles.description })
      .from(companyProfiles)
      .where(eq(companyProfiles.symbol, symbol)),
    db.select({ market: silver.tickers.market }).from(silver.tickers).where(eq(silver.tickers.symbol, symbol)),
  ]);
  if (!p?.name) throw new Error(`no company profile for ${symbol} yet, cannot pick its local-press terms`);
  const input = `${industryInput(symbol, p)}\nListed in: ${t?.market ?? "unknown"}`;
  const questionKey = `${LOCAL_TERMS_QUESTION}:${fnv(input)}`;
  const key = and(eq(judgments.subjectKind, SUBJECT_KIND), eq(judgments.subjectId, symbol), eq(judgments.questionKey, questionKey));
  const read = (raw: unknown) => ({ names: (raw as LocalTerms).names, industry: (raw as LocalTerms).industry });
  const [stored] = await db.select().from(judgments).where(key);
  if (stored) return read(stored.raw);
  if (!complete) throw new Error(`local-press terms for ${symbol} are not judged yet and this run has no LLM`);

  const { text, model } = await complete({ system: SYSTEM, prompt: input });
  const { names, industry, reason } = parseLocalTerms(text);
  await db
    .insert(judgments)
    .values({ subjectKind: SUBJECT_KIND, subjectId: symbol, questionKey, question: SYSTEM, verdict: "terms", probability: 1, citedSentence: null, reason, model, raw: { text, names, industry, input } })
    .onConflictDoNothing();
  const [row] = await db.select().from(judgments).where(key);
  return read(row.raw);
}
