import type { DocCitation } from "@/db/schema/analysis";
import type { Db } from "@/db/types";
import { resultsPages, verifyQuote, type ResultsPage } from "../filing-documents/read";

/**
 * The company documents a reversal judge reads (ported from the old driver judge, INFLECTION-1117): filed in the last
 * 12 months, the newest few, their best results pages; and the cleanup of what it cites.
 */
export const DOC_MONTHS = 12;
export const DOCS_READ = 4;
export const PAGES_PER_DOC = 2;
/** A page is cut to this many characters in the prompt (the quote is still checked against the whole stored page). */
export const PAGE_PROMPT_CHARS = 3_500;

/** A quote as the judge cites it: the page label it read (`D1`), the page number, the words. */
export type RawCitation = { doc: string; page: number; quote: string };
/** The pages a judge reads, labelled `D1`, `D2`... by document, newest first. */
export type ReadPages = { label: string; page: ResultsPage }[];

/** The newest documents of the last 12 months and their results pages, labelled for the prompt. */
export async function pagesToRead(db: Db, symbol: string, now = new Date()): Promise<ReadPages> {
  const from = new Date(now.getTime() - DOC_MONTHS * 30.5 * 86_400_000);
  const pages = await resultsPages(db, symbol, { from, to: now }, PAGES_PER_DOC);
  const ids = [...new Set(pages.map((p) => p.document.id))].slice(0, DOCS_READ);
  return pages.filter((p) => ids.includes(p.document.id)).map((page) => ({ label: `D${ids.indexOf(page.document.id) + 1}`, page }));
}

/** The pages as the prompt shows them: `[D1 page 12] <title> (filed 2026-08-14)` then the page text. */
export function pagesText(pages: ReadPages): string {
  if (pages.length === 0) return "No company document of the last 12 months is stored: say what the figures and events show, and cite nothing.";
  return pages.map(({ label, page: p }) => `[${label} page ${p.page}] ${p.document.title} (filed ${p.document.filedAt.toISOString().slice(0, 10)})\n${p.text.slice(0, PAGE_PROMPT_CHARS)}`).join("\n\n");
}

/** What of the pages enters a judgment key: which pages were read, never their text. */
export const pagesKey = (pages: ReadPages) => pages.map((p) => `${p.page.document.id}:${p.page.page}`).join(",");

/** The citations of an answer as written: label, page, quote (a malformed one is dropped). */
export function rawCitations(x: unknown): RawCitation[] {
  return (Array.isArray(x) ? (x as Record<string, unknown>[]) : [])
    .map((c) => ({ doc: String(c?.doc ?? "").trim(), page: Number(c?.page), quote: typeof c?.quote === "string" ? c.quote.trim() : "" }))
    .filter((c) => c.doc && Number.isInteger(c.page) && c.page >= 1 && c.quote.length >= 8);
}

/**
 * Deterministic cleanup after the judge (never a retry): a citation stays only when its label names a document the
 * judge was shown AND its quote is printed on the page it cites (`verifyQuote`).
 */
export async function keepPrintedCitations(db: Db, cited: RawCitation[], pages: ReadPages): Promise<DocCitation[]> {
  const docs = new Map(pages.map((p) => [p.label, p.page.document]));
  const out: DocCitation[] = [];
  for (const c of cited) {
    const doc = docs.get(c.doc);
    if (!doc || c.page > doc.pageCount) continue;
    if (!(await verifyQuote(db, doc.id, c.page, c.quote))) continue;
    if (out.some((x) => x.documentId === doc.id && x.page === c.page && x.quote === c.quote)) continue;
    out.push({ documentId: doc.id, page: c.page, quote: c.quote, title: doc.title, filedAt: doc.filedAt.toISOString().slice(0, 10) });
  }
  return out;
}
