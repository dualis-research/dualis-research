import { inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { goldEmphasis } from "@/db/schema/emphasis";
import { emphasisKey, stringsOf, swapStrings } from "@/emphasis/emphasis";

/**
 * The same value with every text that has a bold copy (`gold.emphasis`, dimension `emphasis`) swapped for it: one
 * query per read. The console renders the swapped texts with `Rich`.
 */
export async function withBold<T>(value: T): Promise<T> {
  const texts = [...stringsOf(value)];
  if (texts.length === 0) return value;
  const byKey = new Map(texts.map((t) => [emphasisKey(t), t]));
  const bold = new Map<string, string>();
  const keys = [...byKey.keys()];
  for (let i = 0; i < keys.length; i += 1000) {
    for (const r of await getDb().select().from(goldEmphasis).where(inArray(goldEmphasis.key, keys.slice(i, i + 1000)))) bold.set(byKey.get(r.key)!, r.emphasized);
  }
  return bold.size === 0 ? value : swapStrings(value, bold);
}
