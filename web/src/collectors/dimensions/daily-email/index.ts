import { and, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import type { BronzeFetch } from "@/db/schema/bronze";
import { dailyEmailSends, dailyItemVerdicts, type DigestItem, goldDailyDigests } from "@/db/schema/daily-email";
import { companyProfiles, filings as goldFilings } from "@/db/schema/gold";
import { goldNewsItems, goldNewsLinks } from "@/db/schema/news";
import * as silver from "@/db/schema/silver";
import type { Db } from "@/db/types";
import { astanaDay } from "@/growth/daily";
import { firstJsonObject } from "@/llm/judge";
import type { Dimension, PromoteResult, Source, SourceContext } from "../../types";
import { renderEmail } from "./render";

/**
 * The morning email (DAILY-EMAIL-1123, Thierry 2026-11-23, a separate product from the signal: « in case it misses
 * something. If nothing important happened, you leave it out »). Per ACTIVE watchlist ticker (not only the analysis
 * scope): every news item (company or industry, `news`) and filing (`filings`) that came out in the last days and was
 * never judged is read by Claude ONCE, in batches per ticker: material or not, and when material what happened and why
 * it matters for the business. The day's material items = gold.daily_digests (Astana day), sent as ONE email by the
 * `dualis-mail` Worker (Cloudflare Email Workers, $0, verified Email Routing destinations only). Nothing material = no email.
 * Runs only when named (the 02:00 UTC dualis-cron slot, right after `news` and `filings`): a merge never sends it.
 */
export const DAILY_EMAIL_DIMENSION = "daily-email";
export const JUDGE_SOURCE = "claude";
/** Who gets the email (MAIL_RECIPIENTS secret: [{email, role}]): Kevin (test) AND Thierry (client), Kevin 2026-11-23. */
export const RECIPIENT_ROLES: readonly string[] = ["test", "client"];
export const MAILER_URL = "https://mailer.dualisresearch.com/send";
/** News published (or first seen, undated) in the last 48 h; filings filed in the last 3 days (registries date some by day). */
const NEWS_WINDOW_MS = 48 * 3_600_000;
const FILING_WINDOW_MS = 3 * 86_400_000;
/** A digest never reaches further back than this, even when no email went out for days. */
const DIGEST_MAX_MS = 3 * 86_400_000;
/** Items per Claude call. */
export const BATCH = 40;
const ABOUT_CHARS = 400;

type Kind = DigestItem["kind"];
export type Candidate = {
  kind: Kind;
  itemId: string;
  title: string;
  url: string | null;
  publisher: string | null;
  at: Date | null;
  summary: string | null;
  /** Industry items: the industry terms that found it. Filings: the form. */
  note: string | null;
};
type Batch = { symbol: string; company: string; about: string | null; items: Candidate[] };
const planned = new Map<string, Batch>();

export type Verdict = { id: string; material: boolean; summary: string | null; why: string | null };

const SYSTEM = [
  "You screen the latest news and filings for an equity analyst who follows one listed company. For each item, decide whether it is MATERIAL: a fact that can change what the business earns or is worth.",
  "Material, on the company: results, guidance, a profit warning, a large contract or customer won or lost, an acquisition or disposal, a capital raise, buyback or dividend change, a management or board change, a regulatory or legal decision, a filing with such content.",
  "Material, on its industry (items marked industry): a fact about a competitor, supplier, customer or the company's own market that bears on its business: their results, prices, capacity, demand, a regulation or subsidy of that space.",
  "Not material: macro news (interest rates, oil, currencies, inflation, war, stock indexes), share price recaps or technical analysis with no business fact, stock promotion and listicles, routine filings with no business content (a monthly share count return, a meeting notice, a director's dealing form of no size), articles about a different company with a similar name, and a story already told by another item of the list (keep only the most informative one).",
  "For each item answer: material (true or false); summary = what happened, ONE plain sentence of at most 25 words with the figure when the item gives one; why = for a material item why it matters for this company's business in at most 20 words, else why it is left out in at most 10 words.",
  "Plain English, never a dash, never a price target, upside or advice.",
  'Answer with JSON only, no prose, no code fence: {"items": [{"id": "i1", "material": true, "summary": "...", "why": "..."}, ...]} with every id of the list exactly once.',
].join(" ");

const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "undated");

export function judgePrompt(b: Batch): string {
  const lines = b.items.map((c, i) => {
    const what = c.kind === "industry" ? `industry news (found by: ${c.note})` : c.kind === "filing" ? `filing${c.note ? ` (${c.note})` : ""}` : "company news";
    const summary = c.summary ? ` | ${c.summary.replace(/\s+/g, " ").slice(0, 300)}` : "";
    return `i${i + 1} | ${what} | ${isoDay(c.at)} | ${c.publisher ?? "unknown source"} | ${c.title}${summary}`;
  });
  return [`Company: ${b.company} (${b.symbol})`, b.about ? `What it does: ${b.about.slice(0, ABOUT_CHARS)}` : null, "", "Items:", ...lines].filter((l) => l !== null).join("\n");
}

/** Claude's answer -> one verdict per item, in the list's order. Throws on an id missing, extra or malformed. */
export function parseVerdicts(text: string, count: number): Verdict[] {
  const obj = JSON.parse(firstJsonObject(text)) as { items?: unknown };
  if (!Array.isArray(obj.items)) throw new Error(`daily-email answer holds no "items" list: ${text.slice(0, 200)}`);
  const byId = new Map<string, Verdict>();
  for (const raw of obj.items as Record<string, unknown>[]) {
    if (typeof raw?.id !== "string" || typeof raw.material !== "boolean") throw new Error(`daily-email verdict malformed: ${JSON.stringify(raw).slice(0, 200)}`);
    const summary = typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : null;
    if (raw.material && !summary) throw new Error(`daily-email verdict ${raw.id} is material with no summary`);
    byId.set(raw.id, { id: raw.id, material: raw.material, summary, why: typeof raw.why === "string" && raw.why.trim() ? raw.why.trim() : null });
  }
  const out = Array.from({ length: count }, (_, i) => byId.get(`i${i + 1}`));
  const missing = out.map((v, i) => (v ? null : `i${i + 1}`)).filter(Boolean);
  if (missing.length) throw new Error(`daily-email answer misses ${missing.join(", ")}`);
  return out as Verdict[];
}

/** One Claude call per batch of a ticker's new items; the raw answer lands in bronze. */
export const judgeSource: Source = {
  name: JUDGE_SOURCE,
  requiredEnv: [],
  covers: () => true,
  concurrency: 3,
  async fetch(subject, ctx) {
    const b = planned.get(subject);
    if (!b) throw new Error(`no planned batch for ${subject}`);
    if (!ctx.complete) throw new Error("daily-email needs the LLM");
    const { text, model } = await ctx.complete({ system: SYSTEM, prompt: judgePrompt(b) });
    const request = { symbol: b.symbol, items: b.items.map((c) => `${c.kind}:${c.itemId}`) };
    try {
      const verdicts = parseVerdicts(text, b.items.length);
      return { request, httpStatus: null, payload: { batch: b, model, text, verdicts } };
    } catch (err) {
      return { request, httpStatus: null, payloadText: text, error: (err as Error).message };
    }
  },
};

export const dailyEmailDim: Dimension = {
  name: DAILY_EMAIL_DIMENSION,
  description: "Morning email: every new material news item, industry item and filing of the watchlist, judged once by Claude.",
  sources: [judgeSource],
  subjects: planBatches,
  promote: promoteDailyEmail,
};

/** Active tickers with their company name and what they do; portfolio first, then by symbol. */
async function watched(db: Db) {
  const rows = await db
    .select({ symbol: silver.tickers.symbol, inPortfolio: silver.tickers.inPortfolio, name: companyProfiles.name, about: companyProfiles.description })
    .from(silver.tickers)
    .leftJoin(companyProfiles, eq(companyProfiles.symbol, silver.tickers.symbol))
    .where(sql`${silver.tickers.active}`);
  return rows.sort((a, b) => Number(b.inPortfolio) - Number(a.inPortfolio) || a.symbol.localeCompare(b.symbol));
}

/** Every recent item of every watched ticker never judged yet, in batches of BATCH per ticker. */
export async function planBatches(db: Db, _ctx?: SourceContext, now = new Date()): Promise<string[]> {
  planned.clear();
  const tickers = await watched(db);
  const symbols = tickers.map((t) => t.symbol);
  if (symbols.length === 0) return [];
  const [news, filed, judged] = await Promise.all([
    db
      .select({ symbol: goldNewsLinks.symbol, kinds: goldNewsLinks.matchKinds, terms: goldNewsLinks.matchedTerms, item: goldNewsItems })
      .from(goldNewsLinks)
      .innerJoin(goldNewsItems, eq(goldNewsItems.id, goldNewsLinks.newsItemId))
      .where(and(inArray(goldNewsLinks.symbol, symbols), sql`coalesce(${goldNewsItems.publishedAt}, ${goldNewsItems.firstSeenAt}) >= ${new Date(now.getTime() - NEWS_WINDOW_MS).toISOString()}::timestamptz`)),
    db.select().from(goldFilings).where(and(inArray(goldFilings.symbol, symbols), gte(goldFilings.filedAt, new Date(now.getTime() - FILING_WINDOW_MS)))),
    db
      .select({ symbol: dailyItemVerdicts.symbol, kind: dailyItemVerdicts.kind, itemId: dailyItemVerdicts.itemId })
      .from(dailyItemVerdicts)
      .where(gte(dailyItemVerdicts.createdAt, new Date(now.getTime() - 4 * FILING_WINDOW_MS))),
  ]);
  const done = new Set(judged.map((j) => `${j.symbol}|${j.kind}|${j.itemId}`));
  const per = new Map<string, Candidate[]>();
  const add = (symbol: string, c: Candidate) => {
    if (done.has(`${symbol}|${c.kind}|${c.itemId}`)) return;
    per.set(symbol, [...(per.get(symbol) ?? []), c]);
  };
  for (const n of news) {
    const industryOnly = n.kinds.every((k) => k === "industry");
    add(n.symbol, {
      kind: industryOnly ? "industry" : "news",
      itemId: n.item.id,
      title: n.item.title,
      url: n.item.url,
      publisher: n.item.publisher,
      at: n.item.publishedAt,
      summary: n.item.summary,
      note: industryOnly ? n.terms.join(", ") : null,
    });
  }
  for (const f of filed) add(f.symbol, { kind: "filing", itemId: f.id, title: f.title, url: f.url, publisher: f.registry, at: f.filedAt, summary: null, note: f.form });

  const subjects: string[] = [];
  for (const t of tickers) {
    const items = (per.get(t.symbol) ?? []).sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
    for (let i = 0; i < items.length; i += BATCH) {
      const key = `${t.symbol}|${i / BATCH + 1}`;
      planned.set(key, { symbol: t.symbol, company: t.name ?? t.symbol, about: t.about, items: items.slice(i, i + BATCH) });
      subjects.push(key);
    }
  }
  return subjects;
}

type JudgePayload = { batch: Omit<Batch, "items"> & { items: (Omit<Candidate, "at"> & { at: string | null })[] }; model: string; verdicts: Verdict[] };

export type Recipient = { email: string; role: string };
/** The MAIL_RECIPIENTS secret: [{email, role}]. Every role asked must have a recipient (never a silent half-send). */
export function recipientsFor(env: Record<string, string | undefined>, roles: readonly string[]): string[] {
  const raw = env.MAIL_RECIPIENTS;
  if (!raw) throw new Error("MAIL_RECIPIENTS is not set");
  const list = JSON.parse(raw) as Recipient[];
  for (const role of roles) if (!list.some((r) => r.role === role)) throw new Error(`no ${role} recipient in MAIL_RECIPIENTS`);
  return [...new Set(list.filter((r) => roles.includes(r.role)).map((r) => r.email))];
}

const KIND_ORDER: Record<Kind, number> = { filing: 0, news: 1, industry: 2 };

/** bronze answers -> silver verdicts (once per item) -> gold digest of the Astana day -> the email (once a day). */
export async function promoteDailyEmail(db: Db, fetches: BronzeFetch[], ctx: SourceContext, now = new Date()): Promise<PromoteResult> {
  let written = 0;
  for (const f of fetches.filter((r) => !r.error && r.source === JUDGE_SOURCE)) {
    const p = f.payload as JudgePayload;
    const rows = p.batch.items.map((c, i) => ({
      symbol: p.batch.symbol,
      kind: c.kind,
      itemId: c.itemId,
      title: c.title,
      url: c.url,
      publisher: c.publisher,
      at: c.at ? new Date(c.at) : null,
      material: p.verdicts[i].material,
      summary: p.verdicts[i].summary,
      why: p.verdicts[i].why,
      model: p.model,
      bronzeId: f.id,
    }));
    if (rows.length) written += (await db.insert(dailyItemVerdicts).values(rows).onConflictDoNothing().returning({ s: dailyItemVerdicts.symbol })).length;
  }

  const day = astanaDay(now);
  const tickers = await watched(db);
  const rank = new Map(tickers.map((t, i) => [t.symbol, i]));
  const company = new Map(tickers.map((t) => [t.symbol, t.name ?? t.symbol]));
  const [lastFull] = await db
    .select({ sentAt: dailyEmailSends.sentAt })
    .from(dailyEmailSends)
    .where(and(eq(dailyEmailSends.mode, "full"), inArray(dailyEmailSends.status, ["sent", "partial"])))
    .orderBy(desc(dailyEmailSends.sentAt))
    .limit(1);
  const floor = now.getTime() - DIGEST_MAX_MS;
  const cutoff = new Date(Math.max(floor, lastFull?.sentAt.getTime() ?? floor));
  const material = (await db.select().from(dailyItemVerdicts).where(and(eq(dailyItemVerdicts.material, true), gt(dailyItemVerdicts.createdAt, cutoff)))).filter((v) => rank.has(v.symbol));
  const items: DigestItem[] = material
    .sort((a, b) => rank.get(a.symbol)! - rank.get(b.symbol)! || KIND_ORDER[a.kind as Kind] - KIND_ORDER[b.kind as Kind] || (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))
    .map((v) => ({ symbol: v.symbol, company: company.get(v.symbol)!, kind: v.kind as Kind, title: v.title, url: v.url, publisher: v.publisher, at: v.at?.toISOString() ?? null, summary: v.summary!, why: v.why ?? "" }));
  const email = items.length ? renderEmail(day, items) : null;
  await db
    .insert(goldDailyDigests)
    .values({ day, items, subject: email?.subject ?? null, text: email?.text ?? null, html: email?.html ?? null, builtAt: now })
    .onConflictDoUpdate({ target: goldDailyDigests.day, set: { items, subject: email?.subject ?? null, text: email?.text ?? null, html: email?.html ?? null, builtAt: now } });

  await sendDigest(db, day, items, email, ctx);
  return { silverRowsBySource: { [JUDGE_SOURCE]: written } };
}

/**
 * Sends the day's digest. Nothing material = nothing sent. `DAILY_EMAIL_MODE=test` = Kevin only, any time, never counted
 * as the day's email; otherwise only the scheduled run sends, once per Astana day, to every role of RECIPIENT_ROLES.
 */
async function sendDigest(db: Db, day: string, items: DigestItem[], email: ReturnType<typeof renderEmail> | null, ctx: SourceContext): Promise<void> {
  if (!email) {
    console.log(`[daily-email] ${day}: nothing material, no email`);
    return;
  }
  const mode = ctx.env.DAILY_EMAIL_MODE === "test" ? "test" : "full";
  if (mode === "full") {
    if (ctx.env.COLLECT_TRIGGER !== "schedule") {
      console.log(`[daily-email] ${day}: ${items.length} material items, not sent (only the scheduled run sends; DAILY_EMAIL_MODE=test sends to Kevin)`);
      return;
    }
    const [already] = await db
      .select({ id: dailyEmailSends.id })
      .from(dailyEmailSends)
      .where(and(eq(dailyEmailSends.day, day), eq(dailyEmailSends.mode, "full"), inArray(dailyEmailSends.status, ["sent", "partial"])))
      .limit(1);
    if (already) {
      console.log(`[daily-email] ${day}: already sent today; these items wait for tomorrow's email`);
      return;
    }
  }
  const roles = mode === "test" ? ["test"] : [...RECIPIENT_ROLES];
  const to = recipientsFor(ctx.env, roles);
  if (!ctx.env.MAIL_TOKEN) throw new Error("MAIL_TOKEN is not set");
  let status: string;
  let response: unknown;
  try {
    const res = await ctx.fetch(MAILER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.env.MAIL_TOKEN}`, "Content-Type": "application/json", "User-Agent": "dualis-collector" },
      body: JSON.stringify({ to, ...email }),
    });
    const body = await res.text();
    response = { status: res.status, body: (() => { try { return JSON.parse(body); } catch { return body.slice(0, 2000); } })() };
    const results = (response as { body: { results?: { status: string }[] } }).body?.results ?? [];
    const sent = results.filter((r) => r.status === "sent").length;
    status = res.ok && sent === to.length ? "sent" : sent > 0 ? "partial" : "failed";
  } catch (err) {
    status = "failed";
    response = { error: (err as Error).message };
  }
  const recorded = mode === "test" ? (status === "sent" ? "test" : `test-${status}`) : status;
  await db.insert(dailyEmailSends).values({
    day,
    mode,
    roles,
    recipients: to,
    subject: email.subject,
    items: items.map((i) => `${i.symbol}|${i.kind}|${i.title}`),
    status,
    response: response as object,
  });
  await db.update(goldDailyDigests).set({ sendStatus: recorded, sentAt: new Date() }).where(eq(goldDailyDigests.day, day));
  console.log(`[daily-email] ${day}: ${mode} email to ${to.length} recipient(s): ${status}`);
  if (status === "failed") throw new Error(`daily email not sent: ${JSON.stringify(response).slice(0, 300)}`);
}
