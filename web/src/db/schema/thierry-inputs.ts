import { boolean, index, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { gold } from "./gold";
import { silver } from "./silver";

/**
 * Thierry's inputs (Kevin 2026-11-24): he works only in Claude Desktop, inside a Claude Project nobody can read from
 * outside, so his Claude PUSHES every event to the console's connector (`record_inputs`): each question he asks, each
 * view, analysis or piece of information he gives, each file of his Project his Claude reads. Always HIS words, never
 * Claude's answer. Bronze = every push raw (bronze.fetches, dimension `thierry-inputs`, source `claude-desktop`);
 * silver = one row per event; gold = what the console and the judges read.
 */
export const INPUT_KINDS = ["question", "view", "analysis", "info", "file"] as const;
export type InputKind = (typeof INPUT_KINDS)[number];
export const INPUT_SCOPES = ["ticker", "watchlist", "portfolio", "general"] as const;
export type InputScope = (typeof INPUT_SCOPES)[number];

export const thierryInputs = silver.table(
  "thierry_inputs",
  {
    /** Hash of (kind, scope, symbol, text, file name, said at rounded to the minute): the same event pushed twice is one row. */
    id: text("id").primaryKey(),
    kind: text("kind").$type<InputKind>().notNull(),
    scope: text("scope").$type<InputScope>().notNull(),
    /** Upper case; set when the scope is `ticker`. Any symbol, on his watchlist or not. */
    symbol: text("symbol"),
    /** His words verbatim; for a file, what his Claude read in it. */
    text: text("text").notNull(),
    fileName: text("file_name"),
    /** When he said it (a backfill gives the past date). */
    saidAt: timestamp("said_at", { withTimezone: true }).notNull(),
    /** When it first reached us. */
    pushedAt: timestamp("pushed_at", { withTimezone: true }).notNull().defaultNow(),
    /** The signed-in console user whose Claude pushed it. */
    userId: text("user_id").notNull(),
    /** Every push that carried this event. */
    bronzeIds: uuid("bronze_ids").array().notNull(),
  },
  (t) => [index("silver_thierry_inputs_said").on(t.saidAt)],
);
export type SilverThierryInput = typeof thierryInputs.$inferSelect;

/** Rebuilt from silver right after each push, in the same transaction. */
export const goldThierryInputs = gold.table(
  "thierry_inputs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<InputKind>().notNull(),
    scope: text("scope").$type<InputScope>().notNull(),
    symbol: text("symbol"),
    /** The company's name when the symbol is on the watchlist (gold.tickers) and its profile has one. */
    company: text("company"),
    /** Is the symbol on his watchlist (gold.tickers)? */
    onWatchlist: boolean("on_watchlist").notNull().default(false),
    text: text("text").notNull(),
    fileName: text("file_name"),
    saidAt: timestamp("said_at", { withTimezone: true }).notNull(),
    pushedAt: timestamp("pushed_at", { withTimezone: true }).notNull(),
    rebuiltAt: timestamp("rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("gold_thierry_inputs_symbol").on(t.symbol, t.saidAt), index("gold_thierry_inputs_said").on(t.saidAt)],
);
export type GoldThierryInput = typeof goldThierryInputs.$inferSelect;
