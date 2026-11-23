import type { DigestItem } from "@/db/schema/daily-email";

/**
 * The email's words and look (Kevin 2026-11-23 on the first test: a thin header and footer in the brand with the logo,
 * each item one very short sentence with its main idea, key words in bold, an icon per kind of item). Dualis copy rules:
 * plain, no dash, no fair value or price target, the disclaimer in the footer. Pure: the digest items in, subject +
 * plain text + HTML out; the header and footer show the white knot from `markUrl`, each company its own logo
 * (Kevin 2026-11-23: « the logo of each company much visible », the kind icons discreet).
 */
export const FOOTER = "Not investment advice. A summary of public news and filings on your watchlist, for information only.";

/** Same kind = same icon, so the eye sorts the email at a glance. */
export const KIND_ICON: Record<DigestItem["kind"], string> = { filing: "📄", news: "📰", industry: "🏭" };
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

export function renderEmail(day: string, items: readonly DigestItem[], markUrl: string): { subject: string; text: string; html: string } {
  const groups = byCompany(items);
  // No count in the subject (Kevin 2026-11-23): the date says which email it is.
  const subject = `Your watchlist, ${shortDay(day)}`;
  const used = (Object.keys(KIND_ICON) as DigestItem["kind"][]).filter((k) => items.some((i) => i.kind === k));

  const text = [
    `Dualis Research. Your watchlist, ${shortDay(day)}`,
    "",
    ...groups.flatMap((g) => [`${g.company} (${g.symbol})`, ...g.items.map((i) => `${KIND_ICON[i.kind]} ${plain(i.summary)}${i.url ? ` ${i.url}` : ""}`), ""]),
    FOOTER,
  ].join("\n");

  const header = band(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle;"><img src="${esc(markUrl)}" width="22" height="22" alt="" style="display:inline-block;vertical-align:middle;border:0;">
<span style="display:inline-block;vertical-align:middle;margin-left:10px;font-family:${FONT};font-size:12px;letter-spacing:0.22em;color:#ffffff;font-weight:600;">DUALIS RESEARCH</span></td>
<td align="right" style="vertical-align:middle;font-family:${FONT};font-size:12px;color:${ON_DARK};">${esc(shortDay(day))}</td>
</tr></table>`,
    "12px 24px",
  );

  const body = `<tr><td style="padding:24px 24px 8px;font-family:${FONT};color:${INK};">
<h1 style="font-size:19px;line-height:1.3;margin:0 0 6px;font-weight:600;">Your watchlist</h1>
<p style="font-size:11px;color:${MUTED};opacity:0.8;margin:0 0 4px;">${used.map((k) => `${KIND_ICON[k]} ${KIND_LABEL[k]}`).join("&nbsp;&nbsp;·&nbsp;&nbsp;")}</p>
${groups
  .map(
    (g) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 10px;"><tr>${
      g.logo
        ? `<td style="vertical-align:middle;padding-right:12px;"><img src="${esc(g.logo)}" width="36" height="36" alt="" style="display:block;width:36px;height:36px;border-radius:8px;border:1px solid #e6e4ef;background:#ffffff;object-fit:contain;"></td>`
        : ""
    }<td style="vertical-align:middle;font-size:16px;font-weight:600;color:${INK};">${esc(g.company)} <span style="color:${MUTED};font-weight:400;font-size:13px;">${esc(g.symbol)}</span></td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${g.items
  .map(
    (i) => `<tr><td style="width:20px;vertical-align:top;font-size:11px;line-height:22px;opacity:0.45;padding:0 0 8px;">${KIND_ICON[i.kind]}</td>
<td style="vertical-align:top;font-size:15px;line-height:1.5;padding:0 0 8px;">${boldHtml(i.summary)}${
      i.url ? ` <a href="${esc(i.url)}" style="color:${INDIGO};font-size:13px;text-decoration:none;white-space:nowrap;">${esc(i.publisher ?? "Source")}&nbsp;&#8599;</a>` : ""
    }</td></tr>`,
  )
  .join("\n")}
</table>`,
  )
  .join("\n")}
</td></tr>`;

  const footer = band(
    `<img src="${esc(markUrl)}" width="14" height="14" alt="" style="display:inline-block;vertical-align:middle;border:0;">
<span style="display:inline-block;vertical-align:middle;margin-left:8px;font-family:${FONT};font-size:11px;line-height:1.5;color:${ON_DARK};">${esc(FOOTER)}</span>`,
    "12px 24px",
  );

  const html = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f4f3f8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-collapse:collapse;">
${header}
${body}
${footer}
</table></body></html>`;
  return { subject, text, html };
}
