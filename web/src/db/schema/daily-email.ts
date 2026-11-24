import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { gold } from "./gold";
import { silver } from "./silver";

/**
 * The morning email (DAILY-EMAIL-1123, Thierry 2026-11-23: « If nothing important happened, you leave it out. A new
 * filing, anything in the industry, you just let me know. It doesn't matter if it's a signal or not, it's a separate
 * product »). Every new news item (company or industry) and filing of a watchlist ticker is judged ONCE by Claude:
 * material or not, and when material what happened and why it matters for the business. Bronze = Claude's raw answer
 * (dimension `daily-email`); silver = one verdict per (ticker, item); gold = the digest of each Astana day.
 */
export const dailyItemVerdicts = silver.table(
  "daily_item_verdicts",
  {
    symbol: text("symbol").notNull(),
    /** `news` (company news), `industry` (news found by an industry term only) or `filing`. */
    kind: text("kind").notNull(),
    /** gold.news_items id, or gold.filings id. */
    itemId: text("item_id").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    publisher: text("publisher"),
    /** When the item came out (published / filed). */
    at: timestamp("at", { withTimezone: true }),
    material: boolean("material").notNull(),
    /** What happened, one plain sentence (material items only). */
    summary: text("summary"),
    /** Why it matters for the business (material) or why it was left out. */
    why: text("why"),
    /** Material items: 1-10, how much it can change what the company earns or is worth (the email's order). */
    importance: integer("importance"),
    /** `low` / `medium` / `high` / `critical` (URGENT-NEWS-1124): only `critical` starts an urgent email. Null = judged before levels existed. */
    level: text("level"),
    model: text("model").notNull(),
    bronzeId: uuid("bronze_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.kind, t.itemId] }), index("daily_item_verdicts_created").on(t.createdAt)],
);

/** Every email the mailer was asked to send: which day, who, what it answered. Append-only. */
export const dailyEmailSends = silver.table("daily_email_sends", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Astana day of the email (YYYY-MM-DD). */
  day: text("day").notNull(),
  /** `full` (every recipient role of the config) or `test` (Kevin only): a test never counts as the day's email. */
  mode: text("mode").notNull(),
  roles: text("roles").array().notNull(),
  recipients: text("recipients").array().notNull(),
  subject: text("subject").notNull(),
  /** Material items the email carried (`symbol|kind|title`). */
  items: text("items").array().notNull(),
  /** `sent` (every recipient), `partial`, `failed`. */
  status: text("status").notNull(),
  /** The mailer's raw answer, or the error. */
  response: jsonb("response").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Urgent emails (URGENT-NEWS-1124): one row per critical item the mailer was asked about. A `full` row is claimed
 * (`sending`) BEFORE the mail leaves and the unique index below lets one run only hold an item, so an item is alerted
 * at most once ever, whatever runs overlap; a `failed` send frees it for the next hourly run. `test` rows (Kevin only)
 * never count as the item's alert.
 */
export const urgentAlertSends = silver.table(
  "urgent_alert_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    symbol: text("symbol").notNull(),
    kind: text("kind").notNull(),
    itemId: text("item_id").notNull(),
    /** `full` (every recipient role) or `test` (Kevin only). */
    mode: text("mode").notNull(),
    roles: text("roles").array().notNull(),
    recipients: text("recipients").array().notNull(),
    subject: text("subject").notNull(),
    /** `sending` (claimed), `sent` (every recipient), `partial`, `failed`. */
    status: text("status").notNull(),
    /** The mailer's raw answer, or the error. */
    response: jsonb("response").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("urgent_alert_sends_once").on(t.symbol, t.kind, t.itemId).where(sql`mode = 'full' and status <> 'failed'`)],
);

export type DigestItem = {
  symbol: string;
  company: string;
  /** The company's logo URL (gold.company_profiles), shown beside its name. */
  logo?: string | null;
  kind: "news" | "industry" | "filing";
  title: string;
  url: string | null;
  publisher: string | null;
  at: string | null;
  summary: string;
  why: string;
  importance?: number | null;
};

/** One row per Astana day the digest was built: what the email holds (empty = nothing material, no email). */
export const goldDailyDigests = gold.table("daily_digests", {
  day: text("day").primaryKey(),
  items: jsonb("items").$type<DigestItem[]>().notNull(),
  subject: text("subject"),
  text: text("text"),
  html: text("html"),
  /** Last send of that day: `sent` / `partial` / `failed` / `test`, null = not sent (nothing material). */
  sendStatus: text("send_status"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
});
