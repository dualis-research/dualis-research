import type { DigestItem } from "@/db/schema/daily-email";

/**
 * The email's words and look (Kevin 2026-11-23 on the first test: a thin header and footer in the brand with the logo,
 * each item one very short sentence with its main idea, key words in bold, an icon per kind of item). Dualis copy rules:
 * plain, no dash, no fair value or price target, the disclaimer in the footer. Pure: the digest items in, subject +
 * plain text + HTML out; the header and footer show the white knot from `<assets>/mark-white.png`, each company its own logo
 * (Kevin 2026-11-23: « the logo of each company much visible », the kind icons discreet).
 */
export const FOOTER = "Not investment advice. A summary of public news and filings on your watchlist, for information only.";

/**
 * Same kind = same icon, so the eye sorts the email at a glance: grey Phosphor icons (FileText, Newspaper, Factory)
 * served as PNGs by the mailer at `<assets>/icons/<kind>.png` (Kevin 2026-11-23: the emojis did not show, « des icônes
 * plus propres sans couleurs »).
 */
export const KINDS: readonly DigestItem["kind"][] = ["filing", "news", "industry"];
const KIND_LABEL: Record<DigestItem["kind"], string> = { filing: "Filing", news: "Company news", industry: "Industry" };

const INK = "#1A1640";
const INDIGO = "#2B2463";
const MUTED = "#6b6880";
const ON_DARK = "#C9C6E0";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-24" -> "Nov 24". */
export const shortDay = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Never a long dash in what we send (copy rule), whatever the model wrote. */
export const noDash = (s: string) => s.replace(/\s*[—–]\s*/g, ", ");
/** `**word**` (the judge's bold) -> <strong>, the rest escaped. */
export const boldHtml = (s: string) => esc(noDash(s)).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
export const plain = (s: string) => noDash(s).replace(/\*\*(.+?)\*\*/g, "$1");

/** Items grouped per company, companies in the order of their first item (the digest is pre-sorted). */
export function byCompany(items: readonly DigestItem[]): { symbol: string; company: string; logo: string | null; items: DigestItem[] }[] {
  const out = new Map<string, { symbol: string; company: string; logo: string | null; items: DigestItem[] }>();
  for (const i of items) {
    const g = out.get(i.symbol) ?? { symbol: i.symbol, company: i.company, logo: i.logo ?? null, items: [] };
    g.items.push(i);
    out.set(i.symbol, g);
  }
  return [...out.values()];
}

const band = (inner: string, pad: string) =>
  `<tr><td style="background:${INK};padding:${pad};">${inner}</td></tr>`;

const markUrl = (assets: string) => `${assets}/mark-white.png`;
const icon = (assets: string, k: DigestItem["kind"], size: number) =>
  `<img src="${esc(`${assets}/icons/${k}.png`)}" width="${size}" height="${size}" alt="${KIND_LABEL[k]}" title="${KIND_LABEL[k]}" style="display:inline-block;vertical-align:middle;border:0;width:${size}px;height:${size}px;">`;

const headerBand = (assets: string, day: string) =>
  band(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle;"><img src="${esc(markUrl(assets))}" width="22" height="22" alt="" style="display:inline-block;vertical-align:middle;border:0;">
<span style="display:inline-block;vertical-align:middle;margin-left:8px;font-family:${FONT};font-size:11px;letter-spacing:0.14em;color:#ffffff;font-weight:600;white-space:nowrap;">DUALIS RESEARCH</span></td>
<td align="right" style="vertical-align:middle;font-family:${FONT};font-size:11px;color:${ON_DARK};white-space:nowrap;padding-left:8px;">${esc(shortDay(day))}</td>
</tr></table>`,
    "12px 16px",
  );

const footerBand = (assets: string, words: string) =>
  band(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="width:22px;vertical-align:top;padding-top:2px;"><img src="${esc(markUrl(assets))}" width="14" height="14" alt="" style="display:block;border:0;"></td>
<td style="vertical-align:top;font-family:${FONT};font-size:11px;line-height:1.5;color:${ON_DARK};">${esc(words)}</td>
</tr></table>`,
    "12px 16px",
  );

const page = (rows: string[]) => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:0;background:#f4f3f8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;margin:0 auto;background:#ffffff;border-collapse:collapse;table-layout:fixed;">
${rows.join("\n")}
</table></body></html>`;

const companyRow = (g: { symbol: string; company: string; logo: string | null }, margin: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:${margin};"><tr>${
    g.logo
      ? `<td style="vertical-align:middle;padding-right:12px;"><img src="${esc(g.logo)}" width="36" height="36" alt="" style="display:block;width:36px;height:36px;border-radius:8px;border:1px solid #e6e4ef;background:#ffffff;object-fit:contain;"></td>`
      : ""
  }<td style="vertical-align:middle;font-size:16px;font-weight:600;color:${INK};overflow-wrap:anywhere;word-break:break-word;">${esc(g.company)} <span style="color:${MUTED};font-weight:400;font-size:13px;">${esc(g.symbol)}</span></td></tr></table>`;

/** One item: its kind icon, the bold sentence, then only the arrow linking the source (Kevin 2026-11-23: no outlet name, « on s'en fout »). */
const itemRow = (assets: string, i: DigestItem) => `<tr><td style="width:26px;vertical-align:top;padding:3px 0 8px;">${icon(assets, i.kind, 17)}</td>
<td style="vertical-align:top;font-size:15px;line-height:1.5;padding:0 0 8px;overflow-wrap:anywhere;word-break:break-word;">${boldHtml(i.summary)}${
  i.url ? `&nbsp;<a href="${esc(i.url)}" title="Open the source" style="color:${INDIGO};text-decoration:none;font-weight:600;">&#8599;</a>` : ""
}</td></tr>`;

export function renderEmail(day: string, items: readonly DigestItem[], assets: string): { subject: string; text: string; html: string } {
  const groups = byCompany(items);
  // No count in the subject (Kevin 2026-11-23): the date says which email it is.
  const subject = `Your watchlist, ${shortDay(day)}`;
  const used = KINDS.filter((k) => items.some((i) => i.kind === k));

  const text = [
    `Dualis Research. Your watchlist, ${shortDay(day)}`,
    "",
    ...groups.flatMap((g) => [`${g.company} (${g.symbol})`, ...g.items.map((i) => `${KIND_LABEL[i.kind]}: ${plain(i.summary)}${i.url ? ` ${i.url}` : ""}`), ""]),
    FOOTER,
  ].join("\n");

  const body = `<tr><td style="padding:22px 16px 8px;font-family:${FONT};color:${INK};overflow-wrap:anywhere;word-break:break-word;">
<h1 style="font-size:19px;line-height:1.3;margin:0 0 6px;font-weight:600;">Your watchlist</h1>
<p style="font-size:11px;color:${MUTED};opacity:0.8;margin:0 0 4px;">${used.map((k) => `<span style="display:inline-block;white-space:nowrap;margin:0 14px 4px 0;">${icon(assets, k, 14)}&nbsp;<span style="vertical-align:middle;">${KIND_LABEL[k]}</span></span>`).join(" ")}</p>
${groups
  .map(
    (g) => `${companyRow(g, "26px 0 10px")}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${g.items.map((i) => itemRow(assets, i)).join("\n")}
</table>`,
  )
  .join("\n")}
</td></tr>`;

  return { subject, text, html: page([headerBand(assets, day), body, footerBand(assets, FOOTER)]) };
}

export const URGENT_FOOTER = "Not investment advice. An alert on public news and filings on your watchlist, for information only.";
/** A subject line stays readable in an inbox list: cut at a word, never mid-word. */
export const SUBJECT_MAX = 110;
const trimSubject = (s: string) => (s.length <= SUBJECT_MAX ? s : `${s.slice(0, SUBJECT_MAX - 1).replace(/\s+\S*$/, "")}…`);
const RED = "#B42318";
const RED_TINT = "#FDECEA";

/**
 * The urgent email (URGENT-NEWS-1124): ONE critical item, in the morning email's look (same bands, logo, kind icon,
 * bold sentence, arrow to the source) under a small red « URGENT » label, then why it matters. The siren sits in the
 * subject only (Gmail did not show emojis in the body). Same phone rules: nothing wider than a 280 px screen.
 */
export function renderUrgent(day: string, item: DigestItem, assets: string, opts: { test?: boolean } = {}): { subject: string; text: string; html: string } {
  const subject = `${opts.test ? "[TEST] " : ""}${trimSubject(`🚨 Urgent: ${item.company} (${item.symbol}): ${plain(item.summary)}`)}`;
  const why = plain(item.why).trim();
  const text = [
    "Dualis Research. Urgent",
    "",
    `${item.company} (${item.symbol})`,
    `${KIND_LABEL[item.kind]}: ${plain(item.summary)}${item.url ? ` ${item.url}` : ""}`,
    ...(why ? [`Why it matters: ${why}`] : []),
    "",
    URGENT_FOOTER,
  ].join("\n");

  const body = `<tr><td style="padding:22px 16px 14px;font-family:${FONT};color:${INK};overflow-wrap:anywhere;word-break:break-word;">
<span style="display:inline-block;background:${RED_TINT};color:${RED};font-size:11px;font-weight:700;letter-spacing:0.08em;line-height:1;padding:6px 9px;border-radius:4px;">URGENT</span>
${companyRow({ symbol: item.symbol, company: item.company, logo: item.logo ?? null }, "16px 0 12px")}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${itemRow(assets, item)}
</table>
${why ? `<p style="font-size:14px;line-height:1.5;color:${MUTED};margin:2px 0 8px;overflow-wrap:anywhere;word-break:break-word;"><span style="color:${INK};font-weight:600;">Why it matters:</span> ${esc(why)}</p>` : ""}
</td></tr>`;

  return { subject, text, html: page([headerBand(assets, day), body, footerBand(assets, URGENT_FOOTER)]) };
}
