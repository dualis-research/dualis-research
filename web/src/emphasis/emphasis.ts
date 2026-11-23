import { fnv } from "@/collectors/dimensions/analysis/facts";

/**
 * Bold for skimming (Kevin 2026-11-23): pure helpers shared by the `emphasis` dimension (writes the bold copies) and the
 * console (swaps them in, renders `**…**`). Bump EMPHASIS_VERSION to ask every text again.
 */
export const EMPHASIS_VERSION = "emphasis@v1";

/** Texts shorter than this carry no bold: a few words read at a glance already. */
export const MIN_EMPHASIS_CHARS = 40;

/** One stored bold copy per exact text. */
export const emphasisKey = (text: string): string => fnv(`${EMPHASIS_VERSION}\n${text}`);

export const stripBold = (s: string): string => s.replace(/\*\*/g, "");

/** The bold copy has exactly the original's characters once its `**` marks are removed. */
export const sameWords = (original: string, emphasized: string): boolean => stripBold(original) === stripBold(emphasized);

/**
 * Every prose string of a row, by field name, nested json included: the fields listed for its table only (a news
 * headline or a filing title is not the AI's text), long enough to need bold.
 */
export function proseOf(value: unknown, fields: ReadonlySet<string>, out: string[] = [], field: string | null = null): string[] {
  if (typeof value === "string") {
    if (field !== null && fields.has(field) && value.length >= MIN_EMPHASIS_CHARS) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) proseOf(v, fields, out, field);
  } else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) proseOf(v, fields, out, k);
  }
  return out;
}

/** Every string anywhere in a value (the console swaps each one that has a bold copy). */
export function stringsOf(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (value.length >= MIN_EMPHASIS_CHARS) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) stringsOf(v, out);
  } else if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof Map) && !(value instanceof Set)) {
    for (const v of Object.values(value)) stringsOf(v, out);
  }
  return out;
}

/** A copy of `value` with every string that has a bold copy replaced by it (plain objects and arrays only). */
export function swapStrings<T>(value: T, bold: ReadonlyMap<string, string>): T {
  if (typeof value === "string") return (bold.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((v) => swapStrings(v, bold)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swapStrings(v, bold)])) as T;
  }
  return value;
}

export const EMPHASIS_SYSTEM = [
  "You add bold to texts an equity research analyst skims in a dashboard, so that reading ONLY the bold gives the point.",
  "Wrap in **double asterisks** the few words that carry the meaning: the subject, the key figure with its unit, the verdict or turning word (e.g. **operating margin** fell to **8%**, a **structural** change).",
  "About one bold phrase per sentence, one to four words each; never a whole sentence, never more than a third of a text; a very short text may take one bold phrase or none.",
  "Change NOTHING else: every character outside the added ** marks stays exactly as given (words, punctuation, spaces, line breaks, markdown, existing bold).",
  'Answer with JSON only, no prose, no code fence: {"<id>": "<the same text with bold added>", ...}, one entry per id given.',
].join(" ");

export const emphasisPrompt = (items: { id: string; text: string }[]): string => `Texts (JSON):\n${JSON.stringify(Object.fromEntries(items.map((i) => [i.id, i.text])))}`;
