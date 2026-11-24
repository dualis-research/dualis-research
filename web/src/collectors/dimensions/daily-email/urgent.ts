import { and, desc, eq, gte } from "drizzle-orm";
import { dailyItemVerdicts, type DigestItem, urgentAlertSends } from "@/db/schema/daily-email";
import type { Db } from "@/db/types";
import { astanaDay } from "@/growth/daily";
import type { SourceContext } from "../../types";
import { ASSETS_URL, postMail, RECIPIENT_ROLES, recipientsFor } from "./mail";
import { withDriverImpacts } from "./drivers";
import { renderUrgent } from "./render";
import { watched } from "./watched";

/**
 * The urgent email (URGENT-NEWS-1124): a news item or filing the judge read as `critical` goes out at once, one email
 * per item, to Kevin and Thierry. Called after every judging run (the hourly `news-alert`, and the 02:00 `daily-email`
 * for what it judged itself). An item is alerted at most once ever (the claim in silver.urgent_alert_sends).
 * Only the scheduled run sends; `URGENT_ALERT_MODE=test` = ONE sample to Kevin only, subject « [TEST] 🚨 Critical: … », any time,
 * never counted as the item's alert: the freshest critical item, else the most important material one of the last
 * 48 h, else the latest verdict, so the format can be reviewed on a quiet day.
 */
export const URGENT_WINDOW_MS = 6 * 3_600_000;
const TEST_WINDOW_MS = 48 * 3_600_000;

type VerdictRow = typeof dailyItemVerdicts.$inferSelect;
const byImportance = (a: VerdictRow, b: VerdictRow) => (b.importance ?? 0) - (a.importance ?? 0) || b.createdAt.getTime() - a.createdAt.getTime();

export async function sendUrgentAlerts(db: Db, ctx: SourceContext, now = new Date()): Promise<void> {
  const test = ctx.env.URGENT_ALERT_MODE === "test";
  const tickers = await watched(db);
  const of = new Map(tickers.map((t) => [t.symbol, t]));
  // Never an old backlog: only what was judged critical in the last hours.
  const critical = (
    await db
      .select()
      .from(dailyItemVerdicts)
      .where(and(eq(dailyItemVerdicts.level, "critical"), eq(dailyItemVerdicts.material, true), gte(dailyItemVerdicts.createdAt, new Date(now.getTime() - URGENT_WINDOW_MS))))
  )
    .filter((v) => of.has(v.symbol))
    .sort(byImportance);
  const item = (v: VerdictRow): DigestItem => ({
    symbol: v.symbol,
    company: of.get(v.symbol)?.name ?? v.symbol,
    logo: of.get(v.symbol)?.logo ?? null,
    kind: v.kind as DigestItem["kind"],
    itemId: v.itemId,
    title: v.title,
    url: v.url,
    publisher: v.publisher,
    at: v.at?.toISOString() ?? null,
    summary: v.summary ?? v.title,
    why: v.why ?? "",
    importance: v.importance,
    keyPoints: v.keyPoints ?? null,
  });
  // Key points come with the verdict; the Price Drivers it bears on are read from the evidence judge's verdicts.
  const full = async (v: VerdictRow) => (await withDriverImpacts(db, [item(v)]))[0];
  const day = astanaDay(now);

  if (test) {
    let pick: VerdictRow | undefined = critical[0];
    if (!pick) {
      const recent = await db.select().from(dailyItemVerdicts).where(and(eq(dailyItemVerdicts.material, true), gte(dailyItemVerdicts.createdAt, new Date(now.getTime() - TEST_WINDOW_MS))));
      pick = recent.sort(byImportance)[0];
    }
    if (!pick) [pick] = await db.select().from(dailyItemVerdicts).orderBy(desc(dailyItemVerdicts.createdAt)).limit(1);
    if (!pick) {
      console.log("[urgent] test: no verdict stored yet, nothing to show");
      return;
    }
    const email = renderUrgent(day, await full(pick), ASSETS_URL, { test: true });
    const roles = ["test"];
    const to = recipientsFor(ctx.env, roles);
    const { status, response } = await postMail(ctx, to, email);
    await db.insert(urgentAlertSends).values({ symbol: pick.symbol, kind: pick.kind, itemId: pick.itemId, mode: "test", roles, recipients: to, subject: email.subject, status, response });
    console.log(`[urgent] test email to ${to.length} recipient(s): ${status} (${email.subject})`);
    if (status === "failed") throw new Error(`urgent test email not sent: ${JSON.stringify(response).slice(0, 300)}`);
    return;
  }

  if (critical.length === 0) return;
  if (ctx.env.COLLECT_TRIGGER !== "schedule") {
    console.log(`[urgent] ${critical.length} critical item(s), not sent (only the scheduled run sends; URGENT_ALERT_MODE=test sends a sample to Kevin)`);
    return;
  }
  const roles = [...RECIPIENT_ROLES];
  const to = recipientsFor(ctx.env, roles);
  const failed: string[] = [];
  for (const v of critical) {
    const email = renderUrgent(day, await full(v), ASSETS_URL);
    // The claim: one run only gets the row (unique while not failed), so two overlapping runs never both send.
    const [claim] = await db
      .insert(urgentAlertSends)
      .values({ symbol: v.symbol, kind: v.kind, itemId: v.itemId, mode: "full", roles, recipients: to, subject: email.subject, status: "sending", response: {} })
      .onConflictDoNothing()
      .returning({ id: urgentAlertSends.id });
    if (!claim) continue;
    let sent: Awaited<ReturnType<typeof postMail>>;
    try {
      sent = await postMail(ctx, to, email);
    } catch (err) {
      sent = { status: "failed", response: { error: (err as Error).message } };
    }
    await db.update(urgentAlertSends).set({ status: sent.status, response: sent.response, sentAt: new Date() }).where(eq(urgentAlertSends.id, claim.id));
    console.log(`[urgent] ${v.symbol}: ${sent.status} to ${to.length} recipient(s) (${email.subject})`);
    if (sent.status === "failed") failed.push(`${v.symbol}: ${JSON.stringify(sent.response).slice(0, 200)}`);
  }
  if (failed.length) throw new Error(`urgent email not sent (retried by the next run): ${failed.join("; ")}`);
}
