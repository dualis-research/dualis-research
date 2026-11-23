import { boolean, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { gold } from "./gold";
import { silver } from "./silver";

/**
 * Bold for skimming (Kevin 2026-11-23: « add bold wherever necessary to make the reading faster », « Same in ALL text
 * the AI writes »): every text Claude wrote that the console shows gets a second, separate pass that wraps its key
 * words in `**…**`, ONCE per text (key = hash of the version + the exact text, `emphasisKey`). The original text stays
 * untouched in its own table (every hash, judgment and published post reads it); the console swaps in the bold copy
 * when it shows it. `ok` = the bold copy has exactly the original words (a copy that changed a word is kept as a
 * failure with its reason, never shown).
 */
export const emphasis = silver.table("emphasis", {
  key: text("key").primaryKey(),
  text: text("text").notNull(),
  emphasized: text("emphasized"),
  ok: boolean("ok").notNull(),
  error: text("error"),
  model: text("model"),
  bronzeId: uuid("bronze_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** What the console reads: the bold copy of each text, by its key. */
export const goldEmphasis = gold.table("emphasis", {
  key: text("key").primaryKey(),
  emphasized: text("emphasized").notNull(),
  rebuiltAt: timestamp("rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
});
