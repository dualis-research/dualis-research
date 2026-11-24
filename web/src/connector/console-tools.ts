import { outreachStatusValues, type OutreachStatus } from "@/db/schema/growth";
import type { Db } from "@/db/types";
import { withWriteDb } from "@/db/write";
import { recordOutreachEdit } from "@/growth/manual";
import { INPUT_KINDS, INPUT_SCOPES } from "@/db/schema/thierry-inputs";
import { MAX_EVENTS, recordInputs } from "@/inputs/record";

/**
 * The console's acts a Claude does through the connector (Kevin 2026-11-18: « ON NE VEUT PAS CLIQUER »), recorded
 * exactly as the old buttons were (bronze source "console", the signed-in user's id). Drafts are not here (Kevin
 * 2026-11-19): the 2 daily posts reach Thierry on WhatsApp, where « go » counts a post as published. `record_inputs`
 * (Kevin 2026-11-24) = his Claude pushing his own words to us (src/inputs/record.ts, source "claude-desktop").
 */
type Result = { text: string; isError?: boolean };
export type ConsoleToolDeps = { userId: string; write?: <T>(fn: (db: Db) => Promise<T>) => Promise<T> };

const str = { type: "string" } as const;

export const CONSOLE_TOOLS = [
  {
    name: "update_outreach",
    description: "Change an outreach message to a Substack writer and/or its status (sent, replied, cited, declined, dropped, draft), keyed by the writer's handle.",
    inputSchema: { type: "object", properties: { handle: str, status: { type: "string", enum: [...outreachStatusValues] }, message: str }, required: ["handle"], additionalProperties: false },
  },
  {
    name: "record_inputs",
    description:
      "Push Thierry's own inputs to Dualis, BEFORE you answer him: call it on every message of his about a ticker, his watchlist or his portfolio, one event per question he asks, view or opinion he holds, analysis he gives, piece of information he provides, and per file he adds or you read in his Project (kind file: its name + the text and figures you read in it). Always HIS words verbatim, never your answer, never a summary. Dualis keeps them and its analysis reads them. A backfill (the Project's files and past conversations, each event with its saidAt) goes in calls of up to 50 events; pushing the same event twice is harmless.",
    inputSchema: {
      type: "object",
      properties: {
        events: {
          type: "array",
          minItems: 1,
          maxItems: MAX_EVENTS,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: [...INPUT_KINDS], description: "question = he asks; view = his opinion; analysis = his reasoning or numbers; info = a fact he provides; file = a file of his Project." },
              scope: { type: "string", enum: [...INPUT_SCOPES], description: "ticker = one company (give symbol); watchlist; portfolio; general." },
              symbol: { type: "string", description: "Required when scope is ticker, e.g. 1161.HK. Any symbol, on his watchlist or not." },
              text: { type: "string", description: "His words verbatim. For a file: the text and figures you read in it." },
              fileName: { type: "string", description: "Required for kind file." },
              saidAt: { type: "string", description: "ISO date-time he said it, e.g. 2026-11-24T09:30:00Z. Default: now. Always give it in a backfill." },
            },
            required: ["kind", "scope", "text"],
            additionalProperties: false,
          },
        },
      },
      required: ["events"],
      additionalProperties: false,
    },
  },
] as const;

export async function callConsoleTool(name: string, args: Record<string, unknown>, deps: ConsoleToolDeps): Promise<Result | null> {
  const write = deps.write ?? withWriteDb;
  const userId = deps.userId;
  switch (name) {
    case "update_outreach": {
      const handle = String(args.handle ?? "").replace(/^@/, "").trim();
      if (!handle) throw new Error("handle is required");
      const status = args.status ? (String(args.status) as OutreachStatus) : undefined;
      const body = args.message !== undefined ? String(args.message) : undefined;
      if (!status && body === undefined) throw new Error("Give a status and/or a message");
      await write((db) => recordOutreachEdit(db, handle, { ...(status ? { status } : {}), ...(body !== undefined ? { body } : {}), userId }));
      return { text: `@${handle}: ${[status && `status ${status}`, body !== undefined && "message saved"].filter(Boolean).join(", ")}.` };
    }
    case "record_inputs": {
      const { events, onWatchlist } = await write((db) => recordInputs(db, args, userId));
      const groups = new Map<string, number>();
      for (const e of events) groups.set(e.symbol ?? e.scope, (groups.get(e.symbol ?? e.scope) ?? 0) + 1);
      const symbols = [...new Set(events.map((e) => e.symbol).filter((x): x is string => x !== null))];
      const off = symbols.filter((x) => !onWatchlist.has(x));
      const on = symbols.filter((x) => onWatchlist.has(x));
      const where = symbols.length ? ` ${[on.length ? `On his watchlist: ${on.join(", ")}.` : null, off.length ? `Not on his watchlist: ${off.join(", ")}.` : null].filter(Boolean).join(" ")}` : "";
      return { text: `Saved ${events.length} input${events.length === 1 ? "" : "s"} (${[...groups].map(([k, n]) => `${k} x${n}`).join(", ")}).${where}` };
    }
  }
  return null;
}

