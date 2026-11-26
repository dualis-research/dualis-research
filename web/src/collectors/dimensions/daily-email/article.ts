import { and, asc, eq, inArray } from "drizzle-orm";
import { dailyItemTexts, dailyItemVerdicts } from "@/db/schema/daily-email";
import { documentPages } from "@/db/schema/documents";
import type { BronzeFetch } from "@/db/schema/bronze";
import type { Db } from "@/db/types";
import type { FetchOutcome, Source, SourceContext } from "../../types";
import { cleanText, decodeEntities, htmlToText } from "../filing-documents/text";

/**
 * The TEXT of a material item (NEWS-KEY-POINTS-1124, Kevin: « Key summary en 3 bullet points de la news dans le mail »):
 * the key points are written from what the article or filing says, never from its headline. Fetched only for items the
 * judge read as material. A news item = its publisher's page (a Google News link is decoded to it first); a filing =
 * its stored pages (`gold.document_pages`) when `filing-documents` read it, else its own PDF or HTML. Bronze = every
 * fetch, failures included; silver.daily_item_texts = one row per item (ok + text, or failed + why), never fetched again
 * once ok, at most MAX_TEXT_TRIES failed fetches.
 */
export const ARTICLE_SOURCE = "article";
export const MAX_TEXT_TRIES = 3;
/** What the key-points writer reads: enough for any news article and a results filing's opening pages. */
export const MAX_TEXT_CHARS = 12_000;
/** Below this, the page held no article (a paywall, a cookie wall, a page built by script). */
export const MIN_TEXT_CHARS = 300;
const TIMEOUT_MS = 15_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const PAGE_HEADERS = { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" };

/** Node-only modules (pdf.js), hidden from every bundler: the console lists dimensions. */
const nodeImport = (spec: string): Promise<unknown> => import(/* webpackIgnore: true */ spec);

/** Subject of a text fetch: `<symbol>|text|<verdict kind>|<item id>` (symbol first: COLLECT_ONLY keeps it). */
export const textSubject = (symbol: string, kind: string, itemId: string) => `${symbol}|text|${kind}|${itemId}`;
/** `<symbol>|<step>|<kind>|<item id>` -> its parts (the item id may hold any character but the first three `|`). */
export function parseItemSubject(subject: string): { symbol: string; step: string; kind: string; itemId: string } {
  const [symbol, step, kind, ...rest] = subject.split("|");
  return { symbol, step, kind, itemId: rest.join("|") };
}
/** One text per item whatever ticker it came under: company and industry news share the news item. */
export const textKind = (kind: string): "news" | "filing" => (kind === "filing" ? "filing" : "news");

// ---------- Google News links ----------

/** The article id of a Google News link (`news.google.com/rss/articles/<id>`, `/articles/<id>`, `/read/<id>`), else null. */
export function googleArticleId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "news.google.com") return null;
    const m = /\/(?:rss\/)?(?:articles|read)\/([^/?#]+)/.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** The signature and timestamp Google prints on the article's redirect page (`data-n-a-sg`, `data-n-a-ts`). */
export function signatureOf(html: string): { signature: string; timestamp: number } | null {
  const signature = /data-n-a-sg="([^"]+)"/.exec(html)?.[1];
  const timestamp = Number(/data-n-a-ts="([^"]+)"/.exec(html)?.[1]);
  return signature && Number.isFinite(timestamp) && timestamp > 0 ? { signature, timestamp } : null;
}

/**
 * The RPC that turns an article id into its publisher URL. Google renamed it (2026-11-24 live check: `Fm4Ufc` answers
 * 400, `Fbv4je` answers the URL; read in the redirect page's own script, module `aLI87`): the new name first, the old one
 * as a fallback.
 */
export const DECODE_RPCS = ["Fbv4je", "Fm4Ufc"] as const;
const CONTEXT = [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0];

/** The `batchexecute` form body asking the publisher URL of one article. */
export function decodeRequestBody(id: string, timestamp: number, signature: string, rpc: string = DECODE_RPCS[0]): string {
  const inner = JSON.stringify(["garturlreq", CONTEXT, id, timestamp, signature]);
  return `f.req=${encodeURIComponent(JSON.stringify([[[rpc, inner, null, "generic"]]]))}`;
}

/** The publisher URL out of a `batchexecute` answer (`)]}'` then JSON lines; `["wrb.fr", rpc, "[\"garturlres\",\"<url>\",1]"]`), else null. */
export function parseDecodedUrl(text: string): string | null {
  for (const line of text.split("\n")) {
    if (!line.includes("garturlres")) continue;
    let rows: unknown;
    try {
      rows = JSON.parse(line);
    } catch {
      continue;
    }
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!Array.isArray(row) || row[0] !== "wrb.fr" || typeof row[2] !== "string") continue;
      try {
        const inner = JSON.parse(row[2]) as unknown[];
        if (inner[0] === "garturlres" && typeof inner[1] === "string" && /^https?:\/\//.test(inner[1])) return inner[1];
      } catch {
        /* not this row */
      }
    }
  }
  return null;
}

const timed = (ms = TIMEOUT_MS) => AbortSignal.timeout(ms);

/**
 * Google News answers 429 after about ten quick calls (live check 2026-11-24): its calls go one at a time, spaced
 * GOOGLE_SPACING_MS, and a 429 or 503 (its busy answer: 13 links refused on 2026-11-24) waits GOOGLE_RETRY_MS once before giving up (the item is tried again next run).
 */
export const GOOGLE_SPACING_MS = 1_500;
export const GOOGLE_RETRY_MS = 8_000;
let googleQueue: Promise<unknown> = Promise.resolve();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function googleCall(fetchFn: typeof fetch, url: string, init: RequestInit, spacing = GOOGLE_SPACING_MS, retry = GOOGLE_RETRY_MS): Promise<Response> {
  const run = googleQueue.then(async () => {
    let res = await fetchFn(url, { ...init, signal: timed() });
    if ((res.status === 429 || res.status === 503) && retry > 0) {
      await sleep(retry);
      res = await fetchFn(url, { ...init, signal: timed() });
    }
    if (spacing > 0) await sleep(spacing);
    return res;
  });
  googleQueue = run.catch(() => undefined);
  return run;
}

/** A Google News link -> the publisher's URL: its redirect page gives a signature, `batchexecute` answers the URL. */
export async function decodeGoogleNews(url: string, fetchFn: typeof fetch, pace: { spacing?: number; retry?: number } = {}): Promise<string> {
  const id = googleArticleId(url);
  if (!id) throw new Error(`not a Google News article link: ${url}`);
  const call = (u: string, init: RequestInit) => googleCall(fetchFn, u, init, pace.spacing, pace.retry);
  const page = await call(`https://news.google.com/rss/articles/${id}`, { headers: { "User-Agent": UA } });
  if (!page.ok) throw new Error(`Google News redirect page answered HTTP ${page.status}`);
  const sig = signatureOf(await page.text());
  if (!sig) throw new Error("Google News redirect page holds no signature (data-n-a-sg / data-n-a-ts)");
  const tried: string[] = [];
  for (const rpc of DECODE_RPCS) {
    const res = await call("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": UA },
      body: decodeRequestBody(id, sig.timestamp, sig.signature, rpc),
    });
    const found = res.ok ? parseDecodedUrl(await res.text()) : null;
    if (found) return found;
    tried.push(`${rpc}: HTTP ${res.status}`);
  }
  throw new Error(`Google News did not decode the link (${tried.join(", ")})`);
}

// ---------- the article's text ----------

const stripTags = (s: string) => cleanText(decodeEntities(s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")));

/** `articleBody` of the page's schema.org JSON-LD, the publisher's own clean text, when it ships one. */
function jsonLdBody(html: string): string | null {
  let best: string | null = null;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "articleBody" && typeof x === "string" && x.length > (best?.length ?? 0)) best = x;
        else visit(x);
      }
    }
  };
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(m[1].trim()));
    } catch {
      /* a broken block: next */
    }
  }
  return best ? stripTags(best) : null;
}

/**
 * The main text of a news page, no library: the JSON-LD `articleBody` when the publisher ships one, else the paragraphs
 * of its largest `<article>` (else of the whole page) once navigation, header, footer, asides, forms and scripts are
 * dropped; a paragraph under 40 characters (a caption, a share button, a byline) is left out. Null = no article text.
 */
export function extractArticle(html: string): string | null {
  const ld = jsonLdBody(html);
  if (ld && ld.length >= MIN_TEXT_CHARS) return ld.slice(0, MAX_TEXT_CHARS);
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|figure|iframe|button)\b[\s\S]*?<\/\1>/gi, " ");
  const articles = [...body.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1]).sort((a, b) => b.length - a.length);
  const scope = articles[0] && /<p\b/i.test(articles[0]) ? articles[0] : body;
  const paragraphs = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripTags(m[1])).filter((p) => p.length >= 40);
  const text = cleanText([...new Set(paragraphs)].join("\n\n"));
  return text.length >= MIN_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : null;
}

const isPdf = (bytes: Uint8Array, type: string | null) => /pdf/i.test(type ?? "") || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { pdfPages } = (await nodeImport(new URL("../financials/pdf-text.ts", import.meta.url).href)) as typeof import("../financials/pdf-text");
  return cleanText((await pdfPages(bytes)).join("\n\n"));
}

type Read = { url: string; method: string; text: string; httpStatus: number | null };

/** GET a page or a document and read its text: a PDF whole, a filing's HTML whole, a news page's article only. */
async function readUrl(url: string, kind: "news" | "filing", fetchFn: typeof fetch): Promise<Read | { error: string; httpStatus: number | null }> {
  const res = await fetchFn(url, { headers: PAGE_HEADERS, redirect: "follow", signal: timed() });
  if (!res.ok) return { error: `HTTP ${res.status} from ${url}`, httpStatus: res.status };
  const bytes = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get("content-type");
  if (isPdf(bytes, type)) return { url, method: "pdf", text: (await pdfText(bytes)).slice(0, MAX_TEXT_CHARS), httpStatus: res.status };
  const html = new TextDecoder().decode(bytes);
  const text = kind === "filing" ? htmlToText(html).slice(0, MAX_TEXT_CHARS) : extractArticle(html);
  if (!text || text.length < MIN_TEXT_CHARS) return { error: `no article text on the page (${(text ?? "").length} characters: a paywall or a page built by script?)`, httpStatus: res.status };
  return { url, method: kind === "filing" ? "html" : "article", text, httpStatus: res.status };
}

/** A filing's pages as `filing-documents` stored them (gold.document_pages, id = the filing id), else null. */
async function storedFilingText(db: Db, filingId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(filingId)) return null;
  const pages = await db.select({ text: documentPages.text }).from(documentPages).where(eq(documentPages.documentId, filingId)).orderBy(asc(documentPages.page));
  const text = cleanText(pages.map((p) => p.text).join("\n\n"));
  return text.length >= MIN_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : null;
}

export type TextPayload = { kind: "news" | "filing"; itemId: string; url: string | null; method: string; text: string };

export const articleSource: Source = {
  name: ARTICLE_SOURCE,
  requiredEnv: [],
  covers: (subject) => subject.split("|")[1] === "text",
  concurrency: 4,
  async fetch(subject: string, ctx: SourceContext): Promise<FetchOutcome> {
    const { symbol, kind: verdictKind, itemId } = parseItemSubject(subject);
    const kind = textKind(verdictKind);
    const [v] = await ctx.db!.select({ url: dailyItemVerdicts.url }).from(dailyItemVerdicts).where(and(eq(dailyItemVerdicts.symbol, symbol), eq(dailyItemVerdicts.kind, verdictKind), eq(dailyItemVerdicts.itemId, itemId)));
    const request: Record<string, unknown> = { kind, itemId, url: v?.url ?? null };
    if (kind === "filing") {
      const stored = await storedFilingText(ctx.db!, itemId);
      if (stored) return { request, httpStatus: null, payload: { kind, itemId, url: v?.url ?? null, method: "stored-document", text: stored } satisfies TextPayload };
    }
    if (!v?.url) return { request, httpStatus: null, error: "the item has no link" };
    try {
      // Tests pace Google at 0 (GOOGLE_PACE=0); production keeps the spacing.
      const pace = ctx.env.GOOGLE_PACE === "0" ? { spacing: 0, retry: 0 } : {};
      const target = googleArticleId(v.url) ? await decodeGoogleNews(v.url, ctx.fetch, pace) : v.url;
      request.resolved = target;
      const r = await readUrl(target, kind, ctx.fetch);
      if ("error" in r) return { request, httpStatus: r.httpStatus, error: r.error };
      return { request, httpStatus: r.httpStatus, payload: { kind, itemId, url: r.url, method: r.method, text: r.text } satisfies TextPayload };
    } catch (err) {
      return { request, httpStatus: null, error: (err as Error).message };
    }
  },
};

/**
 * bronze text fetches -> silver.daily_item_texts: an ok answer wins for good; a failure counts one try (once per bronze
 * row, so the run's mid-way and final promotions never count it twice) and keeps the latest reason.
 */
export async function writeTexts(db: Db, fetches: BronzeFetch[]): Promise<number> {
  const mine = fetches.filter((f) => f.source === ARTICLE_SOURCE);
  if (mine.length === 0) return 0;
  const keyOf = (f: BronzeFetch) => {
    const { kind, itemId } = parseItemSubject(f.subject);
    return { kind: textKind(kind), itemId };
  };
  const ids = [...new Set(mine.map((f) => keyOf(f).itemId))];
  const existing = new Map((await db.select().from(dailyItemTexts).where(inArray(dailyItemTexts.itemId, ids))).map((r) => [`${r.kind}|${r.itemId}`, r]));
  let written = 0;
  for (const f of mine) {
    const { kind, itemId } = keyOf(f);
    const k = `${kind}|${itemId}`;
    const row = existing.get(k);
    if (row?.status === "ok" || row?.bronzeIds.includes(f.id)) continue;
    const p = f.payload as TextPayload | null;
    const next = !f.error && p
      ? { kind, itemId, status: "ok", text: p.text, url: p.url, method: p.method, why: null, attempts: (row?.attempts ?? 0) + 1, bronzeIds: [...(row?.bronzeIds ?? []), f.id], updatedAt: new Date() }
      : { kind, itemId, status: "failed", text: null, url: (f.request as { resolved?: string; url?: string }).resolved ?? (f.request as { url?: string }).url ?? null, method: null, why: f.error ?? "no text", attempts: (row?.attempts ?? 0) + 1, bronzeIds: [...(row?.bronzeIds ?? []), f.id], updatedAt: new Date() };
    await db.insert(dailyItemTexts).values(next).onConflictDoUpdate({ target: [dailyItemTexts.kind, dailyItemTexts.itemId], set: next });
    existing.set(k, { ...next, createdAt: row?.createdAt ?? new Date() } as typeof dailyItemTexts.$inferSelect);
    written += 1;
  }
  return written;
}
