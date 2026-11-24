/**
 * The collect schedule (Kevin 2026-11-12). GitHub's own `schedule:` is best effort on the free plan: runs came 2-6 h
 * late or never (2026-11-12: no 01:15, 02:00 or 05:15 run, so no 08:00 Growth brief). A Cloudflare Cron Trigger fires
 * on time ($0, 5 per account, all 5 used) and starts `collect.yml` with the dimension each slot runs.
 */
export const SCHEDULE: Record<string, string> = {
  // Twice a day (Kevin 2026-11-16: every watchlist ticker analysed, fewer runs to save the Claude subscription).
  "15 5 * * *": "all", // 05:15 UTC, Asia closed, before the European open: everything
  "15 13 * * *": "core", // 13:15 UTC, before the US open: the analysis chain only
  // 07:00 Astana: fresh count, then the 08:00 Growth brief; the watchlist's news and filings, then the morning email
  // (DAILY-EMAIL-1123, sent when the run ends, ~07:30-08:00 Astana).
  "0 2 * * *": "growth-outreach,substack-network,growth-brief,news,filings,daily-email",
};

/**
 * Slots that start their own workflow instead of collect.yml, each in its own concurrency group, never queued behind a
 * long collect. x-publish.yml (no inputs): every hour from 08:10 to 21:10 Astana, each connected X account posts its
 * next due Sandbox post (Kevin 2026-11-13). news-alert.yml: every hour, day and night, the watchlist's new news and
 * filings are judged and a critical one is emailed at once (URGENT-NEWS-1124); `trigger: schedule` tells it apart from
 * a run started by hand, which never emails Thierry.
 */
export const OWN_WORKFLOW: Record<string, { workflow: string; inputs?: Record<string, string> }> = {
  "10 3-16 * * *": { workflow: "x-publish.yml" },
  "40 * * * *": { workflow: "news-alert.yml", inputs: { trigger: "schedule" } },
};

export const REPO = "dualis-research/dualis-research";
export const WORKFLOW = "collect.yml";

/** The workflow a slot starts and its dispatch body. Throws on a cron this file does not know (wrangler.jsonc drifted). */
export function dispatchFor(cron: string): { workflow: string; body: { ref: string; inputs?: Record<string, string> } } {
  const own = OWN_WORKFLOW[cron];
  if (own) return { workflow: own.workflow, body: { ref: "main", ...(own.inputs ? { inputs: own.inputs } : {}) } };
  return { workflow: WORKFLOW, body: dispatchBody(cron) };
}

/** The workflow_dispatch body for one cron slot. Throws on a cron this file does not know (wrangler.jsonc drifted). */
export function dispatchBody(cron: string): { ref: string; inputs: { dimension: string; trigger: string } } {
  const dimension = SCHEDULE[cron];
  if (!dimension) throw new Error(`Unknown cron "${cron}": add it to SCHEDULE in cron/src/plan.ts`);
  return { ref: "main", inputs: { dimension, trigger: "schedule" } };
}
