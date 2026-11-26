import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { fetches } from "@/db/schema/bronze";
import { dailyItemTexts, dailyItemVerdicts } from "@/db/schema/daily-email";
import type { Db } from "@/db/types";
import { isUsageLimit } from "@/llm/usage-limit";
import { MAX_TEXT_TRIES, textKind, textSubject } from "./article";
import { KEY_POINTS_SOURCE, pointsSubject } from "./key-points";

/** How far back a material item still gets its text and key points (the digest's widest window). */
export const FOLLOW_WINDOW_MS = 48 * 3_600_000;
/** A key-points answer that fails this many times is given up (the item shows its sentence only). */
export const MAX_POINTS_TRIES = 3;
/** Only these levels get their text read and their 3 key points (Kevin 2026-11-26: « Seulement les critical et high »). */
export const KEY_POINT_LEVELS = ["high", "critical"];
/** The dimensions that share these steps (bronze is read across both). */
export const EMAIL_DIMENSIONS = ["daily-email", "news-alert"];

/**
 * What the email dimensions still owe the recent MATERIAL items judged high or critical, after the judge (NEWS-KEY-POINTS-1124): its text
 * (`<symbol>|text|...`, fewer than MAX_TEXT_TRIES failures), then its 3 key points once the text is read
 * (`<symbol>|points|...`). Read from silver at every round, so one run chains judge -> text -> points. The « Price
 * Drivers » line asks nothing: it is read from step D (`drivers.ts`).
 */
export async function followUps(db: Db, now = new Date()): Promise<string[]> {
  const material = await db
    .select({ symbol: dailyItemVerdicts.symbol, kind: dailyItemVerdicts.kind, itemId: dailyItemVerdicts.itemId, keyPoints: dailyItemVerdicts.keyPoints })
    .from(dailyItemVerdicts)
    .where(and(eq(dailyItemVerdicts.material, true), inArray(dailyItemVerdicts.level, KEY_POINT_LEVELS), gte(dailyItemVerdicts.createdAt, new Date(now.getTime() - FOLLOW_WINDOW_MS))));
  if (material.length === 0) return [];
  const texts = new Map(
    (await db.select({ kind: dailyItemTexts.kind, itemId: dailyItemTexts.itemId, status: dailyItemTexts.status, attempts: dailyItemTexts.attempts }).from(dailyItemTexts).where(inArray(dailyItemTexts.itemId, [...new Set(material.map((m) => m.itemId))]))).map((t) => [`${t.kind}|${t.itemId}`, t]),
  );
  const out: string[] = [];
  const wantPoints: string[] = [];
  for (const m of material) {
    const t = texts.get(`${textKind(m.kind)}|${m.itemId}`);
    if (!t || (t.status !== "ok" && t.attempts < MAX_TEXT_TRIES)) out.push(textSubject(m.symbol, m.kind, m.itemId));
    else if (t.status === "ok" && !m.keyPoints) wantPoints.push(pointsSubject(m.symbol, m.kind, m.itemId));
  }
  if (wantPoints.length) {
    const failed = await db
      .select({ subject: fetches.subject, error: fetches.error })
      .from(fetches)
      .where(and(inArray(fetches.dimension, EMAIL_DIMENSIONS), eq(fetches.source, KEY_POINTS_SOURCE), inArray(fetches.subject, wantPoints), isNotNull(fetches.error)));
    const tries = new Map<string, number>();
    // A call the usage limit refused never reached the model: it is not a try.
    for (const f of failed) if (!isUsageLimit(f.error)) tries.set(f.subject, (tries.get(f.subject) ?? 0) + 1);
    out.push(...wantPoints.filter((s) => (tries.get(s) ?? 0) < MAX_POINTS_TRIES));
  }
  return out;
}
