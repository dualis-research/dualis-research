import { companyProfile } from "./dimensions/company-profile";
import { consensusDim } from "./dimensions/consensus";
import { contentAccounts } from "./dimensions/content-accounts";
import { contentDispatch } from "./dimensions/content-dispatch";
import { contentDrafts } from "./dimensions/content-drafts";
import { contentIdeas } from "./dimensions/content-ideas";
import { contentPicks } from "./dimensions/content-picks";
import { contentVisuals } from "./dimensions/content-visuals";
import { contentPosts } from "./dimensions/content-posts";
import { coverPhotos } from "./dimensions/cover-photos";
import { contentReplies } from "./dimensions/content-replies";
import { contentVoices } from "./dimensions/content-voices";
import { news } from "./dimensions/news";
import { newsHistory } from "./dimensions/news/history";
import { onedrive } from "./dimensions/onedrive";
import { onedriveFilings } from "./dimensions/onedrive-filings";
import { earnings } from "./dimensions/earnings";
import { financials } from "./dimensions/financials";
import { analysis } from "./dimensions/analysis";
import { peersDim } from "./dimensions/peers";
import { valuationDim } from "./dimensions/valuation";
import { fxDim } from "./dimensions/fx";
import { marketReactionDim } from "./dimensions/market-reaction";
import { kpiDriversDim } from "./dimensions/kpi-drivers";
import { kpiReversalDim } from "./dimensions/kpi-reversal";
import { signalsDim } from "./dimensions/signals";
import { signalAlertsDim } from "./dimensions/signal-alerts";
import { growthBriefDim } from "./dimensions/growth-brief";
import { growthOutreach } from "./dimensions/growth-outreach";
import { sandboxAccounts } from "./dimensions/sandbox-accounts";
import { sandboxPosts } from "./dimensions/sandbox-posts";
import { sandboxImageFix } from "./dimensions/sandbox-image-fix";
import { sandboxReview } from "./dimensions/sandbox-review";
import { sandboxVisuals } from "./dimensions/sandbox-visuals";
import { substackNetwork } from "./dimensions/substack-network";
import { filingsDimension } from "./dimensions/filings";
import { filingDocumentsDim } from "./dimensions/filing-documents";
import { portfolio } from "./dimensions/portfolio";
import { price } from "./dimensions/price";
import { intradayPrice } from "./dimensions/intraday-price";
import { watchlist } from "./dimensions/watchlist";
import { xPublish } from "./dimensions/x-publish";
import { emphasisDim } from "./dimensions/emphasis";
import { dailyEmailDim } from "./dimensions/daily-email";
import { newsAlertDim } from "./dimensions/news-alert";
import type { Dimension } from "./types";

/**
 * Every dimension, in run order (`collect all` runs them top to bottom).
 * A new dimension = a folder under dimensions/ + one line here. Watchlist first: it defines the subjects. News after company-profile: it queries the resolved names.
 * Outreach before substack-network: the drafted authors join the crawl's candidates.
 * OneDrive (Thierry's research folder) read early; its write-back right after filings.
 * Filing documents (the text of the core reports, results releases and presentations, page by page) right after filings: every claim cites its page.
 * Consensus after earnings: analyst expectations vs actuals, read by the signal that says "above / below what the market expects".
 * Financials after price and filings: EV reads the quote, EDINET the fiscal year end, the PDF extraction the annual report link.
 * Portfolio right after watchlist: Thierry's positions (his posts + console edits); price also fetches the S&P 500 (`^GSPC`) the Portfolio page compares against.
 * FX (daily exchange rates, Yahoo) after peers, before valuation: a fair value computed in the reporting currency is shown in the quote currency.
 * Peers (comparables + analyst targets) after consensus; Valuation (the fair value pyramid) after peers.
 * The analysis is ONE chain, steps A to E of docs/architecture.md (Kevin 2026-11-25), each stored once per input:
 * market-reaction (the common objects: events, significant unbiased 1-week moves, fair value history; code only) ->
 * kpi-drivers (A: Price Driver Candidates read in the events of the significant moves; B: the confidence that each is a
 * Price Driver) -> analysis (C: the narrative, its side and confidence, the Price Drivers that explain it) ->
 * kpi-reversal (D: each Price Driver in continuation, reversal or noise, only on a weak or strong narrative) ->
 * signals (E: is the narrative turning? the Signal is its output) -> signal-alerts -> emphasis.
 * Cover photos right after content-posts: one photo per own article for the website covers.
 * Content ideas after content-voices (the day's Ideas, scored per channel x format); content-picks after it files the day's 2 posts (best X post, best Substack Note); content-drafts after it writes the drafts Thierry asked for and the picks; content-visuals after it draws each drafted Idea's chart, card, video and news capture.
 * Intraday price (5-minute bars, Yahoo) alone in its stage right after price (Yahoo rate limit): it moves gold.quotes to the latest 5-minute price, so EV, valuation, every judge and the live test read the real price, and market reaction the price at the minute a news item lands.
 * Sandbox accounts and posts after content-visuals (Kevin 2026-11-11; signals only since 2026-11-13): each fake account writes 5 posts a day on the day's best signal Ideas, text and picture, from the skills (content-matrix); sandbox-visuals draws each post's picture; sandbox-image-fix (skill image-correction) looks at each picture and corrects its spec until clean (3 passes); sandbox-review (skill content-review) reads them, edits the writing skills on a failure and the day is written again (3 rounds max). A connected X account publishes them (x-publish, below).
 * Growth brief last: it reads the subscriber count and outreach the two before it just rebuilt.
 * X publish (Kevin 2026-11-13) runs ONLY when named (x-publish.yml, every hour): it posts for real on X, and two runs at
 * once would race the account's rotating token, so `all`, `core` and `growth` never include it.
 * Signal alerts right after signals: a Signal Change landing on a strong signal goes to Kevin and Thierry with its picture (a reader of steps C to E, no judgment of its own).
 * News history (NEWS-HISTORY-1123) after news, in its own stage: 3 years of Google News per analysed ticker, each month read once, so the Price Drivers see the news around every past move.
 * Daily email (DAILY-EMAIL-1123) runs only when named, last: the one daily run (02:00 UTC, `all,daily-email`) names it
 * (every watchlist ticker); it judges each new item once and sends the morning email.
 * News alert (URGENT-NEWS-1124) runs only when named too (news-alert.yml, every 6 hours after news and filings): the same
 * judge and verdicts, an urgent email per critical item, never the morning digest.
 * Emphasis after them (Kevin 2026-11-23): a second Claude pass bolds the key words of every text Claude wrote for the console.
 */
export const DIMENSIONS: readonly Dimension[] = [watchlist, portfolio, companyProfile, news, newsHistory, onedrive, price, intradayPrice, filingsDimension, filingDocumentsDim, onedriveFilings, earnings, financials, consensusDim, peersDim, fxDim, valuationDim, marketReactionDim, kpiDriversDim, analysis, kpiReversalDim, signalsDim, signalAlertsDim, emphasisDim, contentAccounts, contentPosts, coverPhotos, contentVoices, contentIdeas, contentPicks, contentDrafts, contentVisuals, sandboxAccounts, sandboxPosts, sandboxVisuals, sandboxImageFix, sandboxReview, contentDispatch, contentReplies, growthOutreach, substackNetwork, growthBriefDim, xPublish, dailyEmailDim, newsAlertDim];

/**
 * Growth and content dimensions (Substack crawl, outreach, posts, voices, drafts); `core` = everything else, the analysis chain.
 */
export const GROWTH_DIMENSIONS: readonly string[] = ["content-accounts", "content-posts", "cover-photos", "content-voices", "content-ideas", "content-picks", "content-drafts", "content-visuals", "sandbox-accounts", "content-dispatch", "content-replies", "growth-outreach", "substack-network", "growth-brief"];

/**
 * Stages of a collect (Kevin 2026-11-06: « comment speeder x10 »): the dimensions of one stage run at the same time,
 * stages one after the other. A stage only reads what earlier stages wrote; Yahoo users (company-profile, price,
 * consensus, financials, peers) sit in different stages so they never hit its rate limit together.
 */
/**
 * Dimensions that run only when named: never part of `all`, `core` or `growth`. The Sandbox writers are off the daily run
 * since 2026-11-24 (Kevin: the Claude subscription ran out every few hours; ~95 calls a day, most refused at the limit).
 */
export const ON_DEMAND_DIMENSIONS: readonly string[] = ["sandbox-posts", "sandbox-visuals", "sandbox-image-fix", "sandbox-review", "x-publish", "daily-email", "news-alert"];

export const STAGES: readonly (readonly string[])[] = [
  ["watchlist"],
  ["portfolio", "company-profile"],
  ["news", "onedrive", "price", "filings", "earnings"],
  ["intraday-price"],
  // Three years of Google News, one month x one term at a time, read once (NEWS-HISTORY-1123): alone, never beside the daily news (one Google rate limit).
  ["news-history"],
  ["onedrive-filings", "filing-documents", "consensus"],
  ["financials"],
  ["peers"],
  ["fx"],
  ["valuation"],
  // The common objects: events, significant unbiased 1-week moves, fair value history (code only).
  ["market-reaction"],
  // A (Price Driver Candidates) and B (Price Drivers: strong | weak | noise).
  ["kpi-drivers"],
  // C: the narrative, its side and confidence, the Price Drivers that explain it.
  ["analysis"],
  // D: each Price Driver in continuation, reversal or noise (only on a weak or strong narrative).
  ["kpi-reversal"],
  // E: is the narrative turning? The Signal.
  ["signals"],
  ["signal-alerts"],
  // Bold on the texts the analysis chain just wrote (Kevin 2026-11-23); the Ideas get theirs on the next run.
  ["emphasis"],
  ...GROWTH_DIMENSIONS.map((d) => [d]),
  ...ON_DEMAND_DIMENSIONS.map((d) => [d]),
];

/** The dimensions to run, grouped by stage, in order. */
export function stagesFor(dimensions: readonly Dimension[]): Dimension[][] {
  const names = new Set(dimensions.map((d) => d.name));
  return STAGES.map((stage) => stage.filter((n) => names.has(n)).map(dimensionByName)).filter((s) => s.length > 0);
}

/**
 * `all`, `core` (all but Growth/content), `growth`, one dimension name, `from:<name>` (that dimension and every later
 * core one: what a change to it can move), or a comma list of those.
 */
export function dimensionsFor(arg: string): readonly Dimension[] {
  const scheduled = DIMENSIONS.filter((d) => !ON_DEMAND_DIMENSIONS.includes(d.name));
  if (arg === "all") return scheduled;
  if (arg === "core") return scheduled.filter((d) => !GROWTH_DIMENSIONS.includes(d.name));
  if (arg === "growth") return scheduled.filter((d) => GROWTH_DIMENSIONS.includes(d.name));
  if (arg.includes(",")) {
    const names = new Set(arg.split(",").flatMap((a) => dimensionsFor(a.trim()).map((d) => d.name)));
    return DIMENSIONS.filter((d) => names.has(d.name));
  }
  if (arg.startsWith("from:")) {
    const i = DIMENSIONS.indexOf(dimensionByName(arg.slice(5)));
    return DIMENSIONS.slice(i).filter((d) => d === DIMENSIONS[i] || (!GROWTH_DIMENSIONS.includes(d.name) && !ON_DEMAND_DIMENSIONS.includes(d.name)));
  }
  return [dimensionByName(arg)];
}

export function dimensionByName(name: string): Dimension {
  const d = DIMENSIONS.find((x) => x.name === name);
  if (!d) throw new Error(`unknown dimension "${name}"; known: ${DIMENSIONS.map((x) => x.name).join(", ")}`);
  return d;
}
