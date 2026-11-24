import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { goldThierryInputs, type GoldThierryInput } from "@/db/schema/thierry-inputs";
import type { Db } from "@/db/types";

/**
 * Thierry's own inputs as context for the judges (Kevin 2026-11-24): what he asked, thinks and knows about a company,
 * pushed by his Claude (gold.thierry_inputs). An input the model weighs, never an override: nobody writes the
 * narrative by hand. Always OUTSIDE a judge's input hash or key: a note informs the next rewrite, it never starts one.
 */
export const TICKER_NOTES = 30;
export const OTHER_NOTES = 10;
/** A note longer than this (a file's text) is cut in the prompt, and says so. */
export const NOTE_CHARS = 2_000;

const line = (n: Pick<GoldThierryInput, "saidAt" | "kind" | "scope" | "text" | "fileName">, chars: number, scope = false) => {
  const text = n.text.replace(/\s+/g, " ").trim();
  const cut = text.length > chars ? `${text.slice(0, chars)} [cut, ${text.length} characters in all]` : text;
  return `- ${n.saidAt.toISOString().slice(0, 10)} ${n.kind}${scope ? ` (${n.scope})` : ""}${n.fileName ? ` « ${n.fileName} »` : ""}: ${cut}`;
};

/** The section of the analysis prompt: his notes on this company (newest 30), then on his watchlist, portfolio or in general (newest 10). Null when he said nothing. */
export async function notesText(db: Db, symbol: string): Promise<string | null> {
  const [own, other] = await Promise.all([
    db.select().from(goldThierryInputs).where(eq(goldThierryInputs.symbol, symbol)).orderBy(desc(goldThierryInputs.saidAt)).limit(TICKER_NOTES),
    db.select().from(goldThierryInputs).where(ne(goldThierryInputs.scope, "ticker")).orderBy(desc(goldThierryInputs.saidAt)).limit(OTHER_NOTES),
  ]);
  if (own.length + other.length === 0) return null;
  return [
    "Thierry's own notes on this company (the analyst's questions, views, analyses, information and files, in his words, newest first; one input to weigh beside the reported facts, his opinion is not a reported figure):",
    own.length ? own.map((n) => line(n, NOTE_CHARS)).join("\n") : "none on this company.",
    other.length ? `His notes on his watchlist, his portfolio or in general:\n${other.map((n) => line(n, NOTE_CHARS, true)).join("\n")}` : null,
  ]
    .filter((x) => x !== null)
    .join("\n");
}

/** Per symbol, his newest views and analyses (the morning email's judge reads them to say why an item matters to his thesis). */
export async function viewsOf(db: Db, symbols: string[], perSymbol = 10, chars = 500): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (symbols.length === 0) return out;
  const rows = await db
    .select()
    .from(goldThierryInputs)
    .where(and(inArray(goldThierryInputs.symbol, symbols), inArray(goldThierryInputs.kind, ["view", "analysis"])))
    .orderBy(desc(goldThierryInputs.saidAt));
  for (const r of rows) {
    const list = out.get(r.symbol!) ?? [];
    if (list.length < perSymbol) out.set(r.symbol!, [...list, line(r, chars).slice(2)]);
  }
  return out;
}
