import type { BronzeFetch } from "@/db/schema/bronze";
import type { Db } from "@/db/types";
import type { Dimension, PromoteResult, SourceContext } from "../../types";
import { EMAIL_SOURCES, emailExpand, emailSubjects, writeSilver } from "../daily-email";
import { sendUrgentAlerts } from "../daily-email/urgent";

/**
 * The hourly urgent alert (URGENT-NEWS-1124): the SAME judge, source and verdict table as the morning email
 * (`daily-email`), run every hour by news-alert.yml right after `news` and `filings`. It judges every item never
 * judged (whichever of the two dimensions runs first judges an item, once), reads the material ones' text, key points
 * and Price Drivers (the same steps, `EMAIL_SOURCES`) and emails each `critical` one at once.
 * It never builds or sends the morning digest. Runs only when named.
 */
export const NEWS_ALERT_DIMENSION = "news-alert";

export async function promoteNewsAlert(db: Db, fetches: BronzeFetch[], ctx: SourceContext, now = new Date()): Promise<PromoteResult> {
  const written = await writeSilver(db, fetches);
  await sendUrgentAlerts(db, ctx, now);
  return { silverRowsBySource: written };
}

export const newsAlertDim: Dimension = {
  name: NEWS_ALERT_DIMENSION,
  description: "Urgent alert: every new news item and filing of the watchlist judged once (low to critical); a critical one is emailed at once.",
  sources: EMAIL_SOURCES,
  subjects: emailSubjects,
  expand: emailExpand,
  promote: promoteNewsAlert,
};
