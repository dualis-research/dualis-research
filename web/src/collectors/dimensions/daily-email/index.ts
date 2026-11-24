import { and, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import type { BronzeFetch } from "@/db/schema/bronze";
import { dailyEmailSends, dailyItemVerdicts, type DigestItem, goldDailyDigests } from "@/db/schema/daily-email";
import { filings as goldFilings } from "@/db/schema/gold";
import { goldNewsItems, goldNewsLinks } from "@/db/schema/news";
import type { Db } from "@/db/types";
import { astanaDay } from "@/growth/daily";
import { viewsOf } from "@/inputs/notes";
import { firstJsonObject } from "@/llm/judge";
import type { Dimension, PromoteResult, Source, SourceContext } from "../../types";
import { ARTICLE_SOURCE, articleSource, writeTexts } from "./article";
import { EVIDENCE_JUDGE_SOURCE, evidenceJudge, withDriverImpacts } from "./drivers";
import { followUps } from "./followups";
import { KEY_POINTS_SOURCE, keyPointsSource, writeKeyPoints } from "./key-points";
import { ASSETS_URL, postMail, RECIPIENT_ROLES, recipientsFor } from "./mail";
import { renderEmail } from "./render";
import { sendUrgentAlerts } from "./urgent";
import { watched } from "./watched";

export { ASSETS_URL, MAILER_URL, type Recipient, RECIPIENT_ROLES, recipientsFor } from "./mail";


/**
 * The morning email (DAILY-EMAIL-1123, Thierry 2026-11-23, a separate product from the signal: « in case it misses
 * something. If nothing important happened, you leave it out »). Per ACTIVE watchlist ticker (not only the analysis
 * scope): every news item (company or industry, `news`) and filing (`filings`) that came out in the last days and was
 * never judged is read by Claude ONCE, in batches per ticker: material or not, and when material what happened and why
 * it matters for the business. The day's material items = gold.daily_digests (Astana day), sent as ONE email by the
 * `dualis-mail` Worker (Cloudflare Email Workers, $0, verified Email Routing destinations only). Nothing material = no email.
 * Runs only when named (the 02:00 UTC dualis-cron slot, right after `news` and `filings`): a merge never sends it.
 * The judge is shared with the hourly `news-alert` (URGENT-NEWS-1124): whichever runs first judges an item, once; it
 * also gives every item a level, and a `critical` one is emailed at once (`urgent.ts`).
 */
export const DAILY_EMAIL_DIMENSION = "daily-email";
export const JUDGE_SOURCE = "claude";
/**
 * The last 24 hours only (Kevin 2026-11-23: « The news should be only last 24h »): news published (or first seen,
 * undated) in the last 24 h; filings filed in the last 48 h, since several registries date a filing by day only
 * (midnight), so yesterday's filing reads up to 48 h old.
 */
export const NEWS_WINDOW_MS = 24 * 3_600_000;
export const FILING_WINDOW_MS = 48 * 3_600_000;
/** What was told in the last days, handed to the judge so a story is never told twice. */
const TOLD_MS = 3 * 86_400_000;
/** Items per Claude call: a ticker's whole day in one call, so one story told by ten outlets is told once. */
export const BATCH = 150;
/** At most this many items per company in one email: asked of the judge per batch, and applied again when the digest is built (the judge runs every hour, so a day holds several batches). */
export const MAX_PER_COMPANY = 3;
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
/** `views` = the analyst's own newest views and analyses on the company (gold.thierry_inputs), so « why » can speak to his thesis; in no key. */
type Batch = { symbol: string; company: string; about: string | null; items: Candidate[]; told: string[]; views?: string[] };
const planned = new Map<string, Batch>();

export const LEVELS = ["low", "medium", "high", "critical"] as const;
export type Level = (typeof LEVELS)[number];
export type Verdict = { id: string; material: boolean; summary: string | null; why: string | null; importance: number | null; level: Level };

const SYSTEM = [
  "You screen the latest news and filings for an equity analyst who follows one listed company among 50. He reads your picks in a two-minute morning email, so the bar is high: pick an item only when it tells him a NEW FACT that can change what this business earns or is worth.",
  "Material, on the company: results, guidance, a profit warning or alert, a large contract or customer won or lost, an acquisition or disposal, a capital raise, buyback or dividend change, a management or board change, a regulatory or legal decision on it, a filing with such content.",
  "Material, on its industry (items marked industry): a new fact from a DIRECT competitor, supplier or customer (their results, guidance, capacity, prices, a big contract) or a regulation, subsidy or ban decided for the company's own market.",
  "Not material: macro news (interest rates, oil, currencies, inflation, war, stock indexes, trade policy in general), share price recaps or technical analysis, opinion pieces, previews, explainers and analyses that add no new fact, stock promotion and listicles, routine filings with no business content (a monthly share count return, a meeting notice), product promotions and sales events, articles about a different company with a similar name, old facts re-told, and any story already in the list or in the already-told list (one story = one item, whichever outlet).",
  `Keep at most ${MAX_PER_COMPANY} material items for this company: the ones that matter most to its business. Every other item is not material.`,
  "For each item answer: material (true or false); summary = the main idea in ONE very short plain sentence of at most 12 words, subject verb object, with the figure when the item gives one, its 2 or 3 key words (who, the figure, the fact) wrapped in **double asterisks**, e.g. \"**Winbond** wins **2027 auto memory orders** in Europe and Japan.\"; why = for a material item why it matters for this company's business in at most 15 words, else why it is left out in at most 10 words; importance = for a material item, 1 to 10, how much it can change what THIS company earns or is worth (10 = results far off expectations, a profit warning, a takeover; 1 = barely material), null for the others. The email is ordered by it, most important first.",
  "When the analyst's own views on the company are given, the why may say how the fact bears on what he thinks; his views never make an item material or raise its level by themselves.",
  "Also give EVERY item a level: low, medium, high or critical (an item that is not material is low). critical = a new fact that can move this company's value sharply right now or break the investment case: a profit warning or results far off expectations, a guidance cut or raise, a takeover offer, merger, major acquisition or disposal, the CEO or CFO leaving, fraud, an investigation or the auditor resigning, a trading halt or suspension, a default, bankruptcy or restructuring, a contract or key customer won or lost that is large relative to its size, a regulatory decision that hits its main business. Critical is rare: the analyst gets an urgent email at once for each. Macro is never critical; an industry item is critical only when it directly changes this company's own business (its main customer goes bankrupt). high, medium, low = decreasing weight for its business.",
  "Plain English, never a dash, never a price target, upside or advice.",
  'Answer with JSON only, no prose, no code fence: {"items": [{"id": "i1", "material": true, "summary": "...", "why": "...", "importance": 7, "level": "high"}, ...]} with every id of the list exactly once.',
].join(" ");

const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "undated");

export function judgePrompt(b: Batch): string {
  const lines = b.items.map((c, i) => {
    const what = c.kind === "industry" ? `industry news (found by: ${c.note})` : c.kind === "filing" ? `filing${c.note ? ` (${c.note})` : ""}` : "company news";
    const summary = c.summary ? ` | ${c.summary.replace(/\s+/g, " ").slice(0, 300)}` : "";
    return `i${i + 1} | ${what} | ${isoDay(c.at)} | ${c.publisher ?? "unknown source"} | ${c.title}${summary}`;
  });
  const told = b.told.length ? ["", "Already told to the analyst in the last days (never pick the same story again):", ...b.told.map((t) => `- ${t}`)] : [];
  const views = b.views?.length ? ["", "The analyst's own views on this company (his words, newest first):", ...b.views.map((v) => `- ${v}`)] : [];
  return [`Company: ${b.company} (${b.symbol})`, b.about ? `What it does: ${b.about.slice(0, ABOUT_CHARS)}` : null, ...views, ...told, "", "Items:", ...lines].filter((l) => l !== null).join("\n");
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
    const importance = raw.material ? raw.importance : null;
    if (raw.material && !(typeof importance === "number" && Number.isInteger(importance) && importance >= 1 && importance <= 10)) {
      throw new Error(`daily-email verdict ${raw.id} is material with no importance 1-10: ${JSON.stringify(raw.importance)}`);
    }
    if (!LEVELS.includes(raw.level as Level)) throw new Error(`daily-email verdict ${raw.id} has no level (low, medium, high, critical): ${JSON.stringify(raw.level)}`);
    // An item that is not material is low by definition, whatever the model wrote.
    const level = raw.material ? (raw.level as Level) : "low";
    byId.set(raw.id, { id: raw.id, material: raw.material, summary, why: typeof raw.why === "string" && raw.why.trim() ? raw.why.trim() : null, importance: importance as number | null, level });
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
  // Judge batches only (`<symbol>|<n>`): the text, key-points and evidence steps have their own sources.
  covers: (subject) => /^\d+$/.test(subject.split("|")[1] ?? ""),
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

/**
 * The steps every email dimension runs (NEWS-KEY-POINTS-1124), round by round in one run: judge the new items, then for
 * the material ones read their text (`article`), write 3 key points from it (`key-points`), and ask the evidence judge
 * the Price Drivers it bears on (`evidence`) when it has not; each round's answers reach silver before the next is planned.
 */
export const EMAIL_SOURCES = [judgeSource, articleSource, keyPointsSource, evidenceJudge];
export const emailSubjects = async (db: Db, ctx?: SourceContext): Promise<string[]> => [...(await planBatches(db, ctx)), ...(await followUps(db))];
export async function emailExpand(db: Db, soFar: BronzeFetch[]): Promise<string[]> {
  await writeSilver(db, soFar);
  return followUps(db);
}
/** Judge verdicts, texts and key points of this run's bronze -> silver (each idempotent: safe mid-run and at promotion). */
export async function writeSilver(db: Db, fetches: BronzeFetch[]): Promise<Record<string, number>> {
  const verdicts = await writeVerdicts(db, fetches);
  const texts = await writeTexts(db, fetches);
  const points = await writeKeyPoints(db, fetches);
  return { [JUDGE_SOURCE]: verdicts, [ARTICLE_SOURCE]: texts, [KEY_POINTS_SOURCE]: points, [EVIDENCE_JUDGE_SOURCE]: fetches.filter((f) => f.source === EVIDENCE_JUDGE_SOURCE && !f.error).length };
}

export const dailyEmailDim: Dimension = {
  name: DAILY_EMAIL_DIMENSION,
  description: "Morning email: every new material news item, industry item and filing of the watchlist, judged once by Claude, with 3 key points read from its text and the Price Drivers it bears on.",
  sources: EMAIL_SOURCES,
  subjects: emailSubjects,
  expand: emailExpand,
  promote: promoteDailyEmail,
};

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
      .select({ symbol: dailyItemVerdicts.symbol, kind: dailyItemVerdicts.kind, itemId: dailyItemVerdicts.itemId, material: dailyItemVerdicts.material, summary: dailyItemVerdicts.summary, createdAt: dailyItemVerdicts.createdAt })
      .from(dailyItemVerdicts)
      .where(gte(dailyItemVerdicts.createdAt, new Date(now.getTime() - 2 * TOLD_MS))),
  ]);
  const done = new Set(judged.map((j) => `${j.symbol}|${j.kind}|${j.itemId}`));
  const toldSince = now.getTime() - TOLD_MS;
  const told = new Map<string, string[]>();
  for (const j of judged) if (j.material && j.summary && j.createdAt.getTime() >= toldSince) told.set(j.symbol, [...(told.get(j.symbol) ?? []), j.summary]);
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

  const views = await viewsOf(db, [...per.keys()]);
  const subjects: string[] = [];
  for (const t of tickers) {
    const items = (per.get(t.symbol) ?? []).sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
    for (let i = 0; i < items.length; i += BATCH) {
      const key = `${t.symbol}|${i / BATCH + 1}`;
      planned.set(key, { symbol: t.symbol, company: t.name ?? t.symbol, about: t.about, items: items.slice(i, i + BATCH), told: told.get(t.symbol) ?? [], views: views.get(t.symbol) ?? [] });
      subjects.push(key);
    }
  }
  return subjects;
}

type JudgePayload = { batch: Omit<Batch, "items" | "told"> & { items: (Omit<Candidate, "at"> & { at: string | null })[] }; model: string; verdicts: Verdict[] };

/**
 * Most important first (Kevin 2026-11-23): inside a company its items by the judge's importance; companies by their
 * most important item, then the sum of their items, then the watchlist order (portfolio first). A verdict made before
 * importance existed counts 0.
 */
export function orderDigest<T extends { symbol: string; importance?: number | null }>(items: readonly T[], rank: ReadonlyMap<string, number>): T[] {
  const imp = (i: T) => i.importance ?? 0;
  const top = new Map<string, number>();
  const sum = new Map<string, number>();
  for (const i of items) {
    top.set(i.symbol, Math.max(top.get(i.symbol) ?? 0, imp(i)));
    sum.set(i.symbol, (sum.get(i.symbol) ?? 0) + imp(i));
  }
  return [...items].sort(
    (a, b) =>
      top.get(b.symbol)! - top.get(a.symbol)! ||
      sum.get(b.symbol)! - sum.get(a.symbol)! ||
      (rank.get(a.symbol) ?? 0) - (rank.get(b.symbol) ?? 0) ||
      imp(b) - imp(a),
  );
}

/** The `max` most important items of each company (the judge's importance, then the newest), the order kept. */
export function capPerCompany<T extends { symbol: string; importance?: number | null; at?: Date | null }>(items: readonly T[], max = MAX_PER_COMPANY): T[] {
  const kept = new Set<T>();
  const per = new Map<string, T[]>();
  for (const i of items) per.set(i.symbol, [...(per.get(i.symbol) ?? []), i]);
  for (const list of per.values()) {
    for (const i of [...list].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0)).slice(0, max)) kept.add(i);
  }
  return items.filter((i) => kept.has(i));
}

/** bronze answers -> silver verdicts, once per (ticker, item): a second answer on the same item is dropped. */
export async function writeVerdicts(db: Db, fetches: BronzeFetch[]): Promise<number> {
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
      importance: p.verdicts[i].importance ?? null,
      level: p.verdicts[i].level,
      model: p.model,
      bronzeId: f.id,
    }));
    if (rows.length) written += (await db.insert(dailyItemVerdicts).values(rows).onConflictDoNothing().returning({ s: dailyItemVerdicts.symbol })).length;
  }
  return written;
}

/** bronze answers -> silver verdicts -> an urgent email per critical item -> gold digest of the Astana day -> the morning email (once a day). */
export async function promoteDailyEmail(db: Db, fetches: BronzeFetch[], ctx: SourceContext, now = new Date()): Promise<PromoteResult> {
  const written = await writeSilver(db, fetches);
  // A failed urgent send never holds the morning email back: it is thrown once the digest is out.
  const urgent = await sendUrgentAlerts(db, ctx, now).then(() => null, (err: Error) => err);

  const day = astanaDay(now);
  const tickers = await watched(db);
  const rank = new Map(tickers.map((t, i) => [t.symbol, i]));
  const company = new Map(tickers.map((t) => [t.symbol, t.name ?? t.symbol]));
  const logoOf = new Map(tickers.map((t) => [t.symbol, t.logo ?? null]));
  const [lastFull] = await db
    .select({ sentAt: dailyEmailSends.sentAt })
    .from(dailyEmailSends)
    .where(and(eq(dailyEmailSends.mode, "full"), inArray(dailyEmailSends.status, ["sent", "partial"])))
    .orderBy(desc(dailyEmailSends.sentAt))
    .limit(1);
  // The last 24 h (filings 48 h, dated by day) and never an item a sent email already carried.
  const floor = now.getTime() - FILING_WINDOW_MS;
  const cutoff = new Date(Math.max(floor, lastFull?.sentAt.getTime() ?? floor));
  const fresh = (v: { kind: string; at: Date | null; createdAt: Date }) =>
    (v.at ?? v.createdAt).getTime() >= now.getTime() - (v.kind === "filing" ? FILING_WINDOW_MS : NEWS_WINDOW_MS);
  const material = (await db.select().from(dailyItemVerdicts).where(and(eq(dailyItemVerdicts.material, true), gt(dailyItemVerdicts.createdAt, cutoff)))).filter((v) => rank.has(v.symbol) && fresh(v));
  const items: DigestItem[] = await withDriverImpacts(
    db,
    orderDigest(capPerCompany(material), rank).map((v) => ({ symbol: v.symbol, company: company.get(v.symbol)!, logo: logoOf.get(v.symbol) ?? null, kind: v.kind as Kind, itemId: v.itemId, title: v.title, url: v.url, publisher: v.publisher, at: v.at?.toISOString() ?? null, summary: v.summary!, why: v.why ?? "", importance: v.importance, keyPoints: v.keyPoints ?? null })),
  );
  const email = items.length ? renderEmail(day, items, ASSETS_URL) : null;
  await db
    .insert(goldDailyDigests)
    .values({ day, items, subject: email?.subject ?? null, text: email?.text ?? null, html: email?.html ?? null, builtAt: now })
    .onConflictDoUpdate({ target: goldDailyDigests.day, set: { items, subject: email?.subject ?? null, text: email?.text ?? null, html: email?.html ?? null, builtAt: now } });

  await sendDigest(db, day, items, email, ctx);
  if (urgent) throw urgent;
  return { silverRowsBySource: written };
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
  const { status, response } = await postMail(ctx, to, email);
  const recorded = mode === "test" ? (status === "sent" ? "test" : `test-${status}`) : status;
  await db.insert(dailyEmailSends).values({
    day,
    mode,
    roles,
    recipients: to,
    subject: email.subject,
    items: items.map((i) => `${i.symbol}|${i.kind}|${i.title}`),
    status,
    response,
  });
  await db.update(goldDailyDigests).set({ sendStatus: recorded, sentAt: new Date() }).where(eq(goldDailyDigests.day, day));
  console.log(`[daily-email] ${day}: ${mode} email to ${to.length} recipient(s): ${status}`);
  if (status === "failed") throw new Error(`daily email not sent: ${JSON.stringify(response).slice(0, 300)}`);
}
