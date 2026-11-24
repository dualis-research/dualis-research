import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { fetches } from "@/db/schema/bronze";
import { companyProfiles, tickers } from "@/db/schema/gold";
import { runSources, runs } from "@/db/schema/ops";
import { goldThierryInputs, INPUT_KINDS, INPUT_SCOPES, thierryInputs, type InputKind, type InputScope } from "@/db/schema/thierry-inputs";
import type { Db } from "@/db/types";

/**
 * A push of Thierry's inputs from his Claude (connector tool `record_inputs`), recorded like every other act: one ops
 * run (trigger "console"), ONE bronze row per tool call (the raw arguments, a refused push included, with why), then
 * silver (one row per event, the same event pushed twice = one row carrying both bronze ids) and gold rebuilt in the
 * same transaction. Fails loud: a wrong event refuses the whole push with the reason.
 */
export const INPUTS_DIMENSION = "thierry-inputs";
export const INPUTS_SOURCE = "claude-desktop";
export const MAX_EVENTS = 50;
/** One event's text: a longer file goes in several events (part 1, part 2 in the file name). */
export const MAX_TEXT_CHARS = 100_000;

export type InputEvent = { kind: InputKind; scope: InputScope; symbol: string | null; text: string; fileName: string | null; saidAt: Date };
export type Recorded = { events: (InputEvent & { id: string })[]; onWatchlist: Set<string> };

const minute = (d: Date) => new Date(Math.floor(d.getTime() / 60_000) * 60_000);

export function inputId(e: InputEvent): string {
  return createHash("sha256").update(JSON.stringify([e.kind, e.scope, e.symbol, e.text, e.fileName, minute(e.saidAt).toISOString()])).digest("hex").slice(0, 32);
}

/** The tool's arguments -> checked events. Throws on the first thing wrong, naming the event. */
export function parseEvents(raw: unknown, now = new Date()): InputEvent[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("events must be a list of 1 to 50 events");
  if (raw.length > MAX_EVENTS) throw new Error(`At most ${MAX_EVENTS} events per call (got ${raw.length}): send the rest in another call`);
  return raw.map((item, i) => {
    const at = `events[${i}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${at} must be an object`);
    const e = item as Record<string, unknown>;
    const unknown = Object.keys(e).filter((k) => !["kind", "scope", "symbol", "text", "fileName", "saidAt"].includes(k));
    if (unknown.length) throw new Error(`${at}: unknown field ${unknown.join(", ")}`);
    if (!(INPUT_KINDS as readonly unknown[]).includes(e.kind)) throw new Error(`${at}.kind must be one of ${INPUT_KINDS.join(", ")}`);
    if (!(INPUT_SCOPES as readonly unknown[]).includes(e.scope)) throw new Error(`${at}.scope must be one of ${INPUT_SCOPES.join(", ")}`);
    const kind = e.kind as InputKind;
    const scope = e.scope as InputScope;
    if (typeof e.text !== "string" || !e.text.trim()) throw new Error(`${at}.text is required: his own words, verbatim`);
    if (e.text.length > MAX_TEXT_CHARS) throw new Error(`${at}.text has ${e.text.length} characters, the limit is ${MAX_TEXT_CHARS}: send it as several events (part 1, part 2 in fileName)`);
    if (e.symbol !== undefined && typeof e.symbol !== "string") throw new Error(`${at}.symbol must be text`);
    const symbol = typeof e.symbol === "string" ? e.symbol.trim().toUpperCase() : "";
    if (scope === "ticker" && !symbol) throw new Error(`${at}.symbol is required when the scope is ticker`);
    if (scope !== "ticker" && symbol) throw new Error(`${at}: a symbol goes with scope ticker (got scope ${scope})`);
    if (/\s/.test(symbol)) throw new Error(`${at}.symbol "${symbol}" is not a ticker symbol`);
    if (e.fileName !== undefined && typeof e.fileName !== "string") throw new Error(`${at}.fileName must be text`);
    const fileName = typeof e.fileName === "string" ? e.fileName.trim() : "";
    if (kind === "file" && !fileName) throw new Error(`${at}.fileName is required for a file`);
    let saidAt = now;
    if (e.saidAt !== undefined) {
      if (typeof e.saidAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(e.saidAt) || Number.isNaN(Date.parse(e.saidAt))) throw new Error(`${at}.saidAt must be an ISO date-time like 2026-11-24T09:30:00Z`);
      saidAt = new Date(e.saidAt);
    }
    return { kind, scope, symbol: symbol || null, text: e.text, fileName: fileName || null, saidAt };
  });
}

/** gold.thierry_inputs = every silver event, with the company's name when its symbol is on the watchlist. */
export async function rebuildGoldInputs(db: Db): Promise<void> {
  // An upsert, never delete-then-insert: two pushes at once (a backfill) must not collide on a row.
  await db.execute(sql`
    insert into ${goldThierryInputs} (id, kind, scope, symbol, company, on_watchlist, text, file_name, said_at, pushed_at)
    select i.id, i.kind, i.scope, i.symbol, p.name, t.symbol is not null, i.text, i.file_name, i.said_at, i.pushed_at
    from ${thierryInputs} i
    left join ${tickers} t on t.symbol = i.symbol
    left join ${companyProfiles} p on p.symbol = t.symbol
    on conflict (id) do update set company = excluded.company, on_watchlist = excluded.on_watchlist, rebuilt_at = now()`);
  await db.execute(sql`delete from ${goldThierryInputs} g where not exists (select 1 from ${thierryInputs} i where i.id = g.id)`);
}

export async function recordInputs(db: Db, args: Record<string, unknown>, userId: string, now = new Date()): Promise<Recorded> {
  const started = Date.now();
  const [run] = await db.insert(runs).values({ dimension: INPUTS_DIMENSION, trigger: "console" }).returning({ id: runs.id });
  const fail = async (err: unknown, bronze: boolean) => {
    const message = err instanceof Error ? err.message : String(err);
    if (bronze) await db.insert(fetches).values({ runId: run.id, dimension: INPUTS_DIMENSION, source: INPUTS_SOURCE, subject: `push:${userId}`, request: { ...args, userId }, httpStatus: null, error: message });
    await db.update(runs).set({ status: "failed", finishedAt: new Date(), error: message }).where(eq(runs.id, run.id));
  };
  let events: (InputEvent & { id: string })[];
  try {
    events = parseEvents(args.events, now).map((e) => ({ ...e, id: inputId(e) }));
  } catch (err) {
    await fail(err, true);
    throw err;
  }
  const [row] = await db
    .insert(fetches)
    .values({ runId: run.id, dimension: INPUTS_DIMENSION, source: INPUTS_SOURCE, subject: `push:${userId}`, request: { ...args, userId }, httpStatus: null, payload: { ids: events.map((e) => e.id) } })
    .returning({ id: fetches.id });
  // The same event twice in one push is one row.
  const unique = [...new Map(events.map((e) => [e.id, e])).values()];
  try {
    await db.transaction(async (tx) => {
      for (const e of unique) {
        await tx
          .insert(thierryInputs)
          .values({ id: e.id, kind: e.kind, scope: e.scope, symbol: e.symbol, text: e.text, fileName: e.fileName, saidAt: e.saidAt, pushedAt: now, userId, bronzeIds: [row.id] })
          .onConflictDoUpdate({ target: thierryInputs.id, set: { bronzeIds: sql`array_append(${thierryInputs.bronzeIds}, ${row.id}::uuid)` } });
      }
      await rebuildGoldInputs(tx as unknown as Db);
    });
  } catch (err) {
    await fail(err, false);
    throw err;
  }
  await db.insert(runSources).values({ runId: run.id, source: INPUTS_SOURCE, status: "ok", requested: events.length, succeeded: events.length, bronzeRows: 1, silverRows: unique.length, durationMs: Date.now() - started });
  await db.update(runs).set({ status: "succeeded", finishedAt: new Date() }).where(eq(runs.id, run.id));
  const symbols = [...new Set(unique.map((e) => e.symbol).filter((s): s is string => s !== null))];
  const known = symbols.length ? await db.select({ symbol: tickers.symbol }).from(tickers) : [];
  return { events: unique, onWatchlist: new Set(known.map((k) => k.symbol).filter((s) => symbols.includes(s))) };
}
