import { and, eq, isNull } from "drizzle-orm";
import { fetches } from "@/db/schema/bronze";
import { companyProfiles } from "@/db/schema/gold";
import * as silver from "@/db/schema/silver";
import type { Db } from "@/db/types";
import type { Dimension, FetchOutcome, SourceContext } from "../../types";
import { EVENT_YEARS } from "../market-reaction/events";
import { analysedSymbols } from "../watchlist";
import { promoteNews } from ".";
import { industryTerms } from "./industry";
import { localTerms } from "./local-terms";
import { cleanCompanyName, googleEdition, parseRss, tickerBase } from "./parse";
import { BROWSER_UA, extractGoogle, type GoogleAnswer, type NewsSource } from "./sources";

/**
 * News history (NEWS-HISTORY-1123): the Price Drivers read 3 years of events per analysed ticker (`EVENT_YEARS`), and
 * news collection only started on 2026-11-04. This dimension reads Google News one calendar MONTH at a time
 * (`after:` / `before:` operators) for every term of the ticker: its name and aliases, its local-press names and
 * industry phrases (`local-terms.ts`), its English industry terms (`industry.ts`). One subject = one term x one month
 * (`SYMBOL|kind|from|to|term`); a month is read once it has ended, ONCE: a window with a successful bronze row is never
 * asked again, a failed one is asked on the next run, so a cut backfill resumes where it stopped. A window that fills
 * Google's 100-item page is split in two until it does not. The articles go through the news dimension's own promote
 * (silver news_items + mentions with every source tag, gold news_items / news_links), so market-reaction reads them
 * with no change. The current month is the daily news' job until it ends.
 */
export const NEWS_HISTORY_DIMENSION = "news-history";

/** Google News RSS answers at most this many items: a full page means the window hides more. */
const GOOGLE_PAGE = 100;
/** Windows read per run (a first backfill of one ticker is ~10 terms x 36 months); the rest waits for the next run. */
export const MAX_WINDOWS_PER_RUN = 400;
const DEFAULT_SPACING_MS = 1500;
/** A 429 / 503 is retried this many times, after `spacing x 20`, then recorded as a failed fetch. */
const RETRIES = 2;
const DAY = 86_400_000;

type Kind = GoogleAnswer["kind"];
export type HistorySubject = { symbol: string; kind: Kind; from: string; to: string; term: string };

export const subjectOf = (s: HistorySubject) => `${s.symbol}|${s.kind}|${s.from}|${s.to}|${s.term}`;

export function parseSubject(subject: string): HistorySubject {
  const [symbol, kind, from, to, ...term] = subject.split("|");
  if (!symbol || !["name", "alias", "industry"].includes(kind) || !from || !to || term.length === 0) throw new Error(`not a news-history subject: ${subject}`);
  return { symbol, kind: kind as Kind, from, to, term: term.join("|") };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Calendar months [first day, first day of the next month) that ended by `now` and end after `now - years`. */
export function historyMonths(now: Date, years = EVENT_YEARS): { from: string; to: string }[] {
  const since = new Date(now.getTime() - years * 365.25 * DAY);
  const out: { from: string; to: string }[] = [];
  let y = since.getUTCFullYear();
  let m = since.getUTCMonth();
  for (;;) {
    const from = new Date(Date.UTC(y, m, 1));
    const to = new Date(Date.UTC(y, m + 1, 1));
    if (to > now) break;
    out.push({ from: isoDay(from), to: isoDay(to) });
    m += 1;
    if (m === 12) [y, m] = [y + 1, 0];
  }
  return out;
}

/** The exact-phrase query of one term over one window; a one-word Latin alias is ANDed with the ticker (as daily). */
export function historyQuery(s: Pick<HistorySubject, "symbol" | "kind" | "term">, from: string, to: string): string {
  const window = `after:${from} before:${to}`;
  const latinWord = s.term.split(/\s+/).length === 1 && !/[^\u0000-ɏ]/.test(s.term);
  return s.kind === "alias" && latinWord ? `"${s.term}" ${tickerBase(s.symbol)} ${window}` : `"${s.term}" ${window}`;
}

/** Every term of a ticker, kind first: name, aliases + local names, industry (English, then local). */
export async function historyTerms(db: Db, symbol: string, ctx: SourceContext): Promise<{ kind: Kind; term: string }[]> {
  const [[t], [p]] = await Promise.all([
    db.select({ aliases: silver.tickers.aliases }).from(silver.tickers).where(eq(silver.tickers.symbol, symbol)),
    db.select({ name: companyProfiles.name }).from(companyProfiles).where(eq(companyProfiles.symbol, symbol)),
  ]);
  if (!p?.name) throw new Error(`no company name for ${symbol} yet, cannot read its news history`);
  const [industry, local] = await Promise.all([industryTerms(db, symbol, ctx.complete), localTerms(db, symbol, ctx.complete)]);
  const out: { kind: Kind; term: string }[] = [];
  const seen = new Set<string>();
  const add = (kind: Kind, raw: string) => {
    const term = raw.trim();
    if (!term || seen.has(term.toLowerCase())) return;
    seen.add(term.toLowerCase());
    out.push({ kind, term });
  };
  add("name", cleanCompanyName(p.name));
  for (const a of [...(t?.aliases ?? []), ...local.names]) add("alias", a);
  for (const i of [...industry, ...local.industry]) add("industry", i);
  return out;
}

async function historySubjects(db: Db, ctx: SourceContext): Promise<string[]> {
  const read = new Set(
    (await db.selectDistinct({ subject: fetches.subject }).from(fetches).where(and(eq(fetches.dimension, NEWS_HISTORY_DIMENSION), isNull(fetches.error)))).map((r) => r.subject),
  );
  const only = ctx.env.COLLECT_ONLY;
  const symbols = (await analysedSymbols(db)).filter((s) => !only || s === only);
  const months = historyMonths(new Date()).reverse(); // newest first: a cut run leaves the oldest months for the next
  const out: string[] = [];
  for (const symbol of symbols) {
    const terms = await historyTerms(db, symbol, ctx);
    for (const m of months) for (const t of terms) {
      const subject = subjectOf({ symbol, ...t, ...m });
      if (!read.has(subject)) out.push(subject);
    }
  }
  return out.slice(0, MAX_WINDOWS_PER_RUN);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

/** One spaced Google News call; a 429 / 503 waits and retries, then returns its last answer. */
async function spacedGet(ctx: SourceContext, url: string): Promise<{ status: number; body: string }> {
  const spacing = Number(ctx.env.NEWS_HISTORY_SPACING_MS ?? DEFAULT_SPACING_MS);
  for (let attempt = 0; ; attempt++) {
    const gap = lastCall + spacing - Date.now();
    if (gap > 0) await wait(gap);
    lastCall = Date.now();
    const res = await ctx.fetch(url, { headers: BROWSER_UA });
    const body = await res.text();
    if ((res.status !== 429 && res.status !== 503) || attempt === RETRIES) return { status: res.status, body };
    await wait(spacing * 20);
  }
}

const midDay = (from: string, to: string) => isoDay(new Date(Math.floor((Date.parse(from) + Date.parse(to)) / 2 / DAY) * DAY));

/** Google News over one term x one month, split while a window fills the page. One bronze row per subject. */
export const googleNewsHistory: NewsSource = {
  name: "google-news",
  requiredEnv: [],
  covers: () => true,
  async fetch(subject, ctx): Promise<FetchOutcome> {
    if (!ctx.db) throw new Error("news-history needs the database to read the ticker's market");
    const s = parseSubject(subject);
    const [t] = await ctx.db.select({ market: silver.tickers.market }).from(silver.tickers).where(eq(silver.tickers.symbol, s.symbol));
    if (!t) throw new Error(`${s.symbol} is not in the watchlist`);
    const answers: GoogleAnswer[] = [];
    const errors: string[] = [];
    const ask = async (from: string, to: string): Promise<void> => {
      const q = historyQuery(s, from, to);
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${googleEdition(s.term, t.market)}`;
      const { status, body } = await spacedGet(ctx, url);
      if (status !== 200) {
        answers.push({ kind: s.kind, term: s.term, q, url, httpStatus: status, body });
        errors.push(`${q}: HTTP ${status}`);
        return;
      }
      let items: number;
      try {
        items = parseRss(body).length;
      } catch (err) {
        answers.push({ kind: s.kind, term: s.term, q, url, httpStatus: status, body });
        errors.push(`${q}: ${(err as Error).message}`);
        return;
      }
      const mid = midDay(from, to);
      if (items >= GOOGLE_PAGE && mid > from && mid < to) {
        await ask(from, mid);
        await ask(mid, to);
        return;
      }
      answers.push({ kind: s.kind, term: s.term, q, url, httpStatus: status, body });
    };
    await ask(s.from, s.to);
    return {
      request: { queries: answers.map((a) => ({ q: a.q, url: a.url })) },
      httpStatus: answers.find((a) => a.httpStatus !== 200)?.httpStatus ?? 200,
      payload: { answers },
      ...(errors.length ? { error: errors.join("; ") } : {}),
    };
  },
  extract: extractGoogle,
};

export const newsHistory: Dimension = {
  name: NEWS_HISTORY_DIMENSION,
  description: "Three years of Google News per analysed ticker, one term x one month at a time, read once (name, aliases, local-press names, industry).",
  sources: [googleNewsHistory],
  subjects: historySubjects,
  promote: async (db, rows) => {
    const froms = rows.map((r) => parseSubject(r.subject).from).sort();
    return promoteNews(db, rows, froms.length ? new Date(Date.parse(froms[0]) - 7 * DAY) : new Date());
  },
};
