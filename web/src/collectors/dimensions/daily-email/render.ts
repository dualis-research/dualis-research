import type { DigestItem } from "@/db/schema/daily-email";

/**
 * The email's words (Dualis copy rules: plain, short, no dash, no fair value or price target, the disclaimer last).
 * Pure: the digest items in, subject + plain text + HTML out.
 */
export const FOOTER = "Not investment advice. A summary of public news and filings on your watchlist, for information only.";

const KIND_LABEL: Record<DigestItem["kind"], string> = { news: "News", industry: "Industry", filing: "Filing" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-24" -> "Nov 24". */
export const shortDay = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Never a long dash in what we send (copy rule), whatever the model wrote. */
export const noDash = (s: string) => s.replace(/\s*[—–]\s*/g, ", ");

/** Items grouped per company, companies in the order of their first item (the digest is pre-sorted). */
export function byCompany(items: readonly DigestItem[]): { symbol: string; company: string; items: DigestItem[] }[] {
  const out = new Map<string, { symbol: string; company: string; items: DigestItem[] }>();
  for (const i of items) {
    const g = out.get(i.symbol) ?? { symbol: i.symbol, company: i.company, items: [] };
    g.items.push(i);
    out.set(i.symbol, g);
  }
  return [...out.values()];
}

export function renderEmail(day: string, items: readonly DigestItem[]): { subject: string; text: string; html: string } {
  const groups = byCompany(items);
  const n = groups.length;
  const subject = `Your watchlist, ${shortDay(day)}: ${n} ${n === 1 ? "company" : "companies"} with news`;
  const line = (i: DigestItem) => `${KIND_LABEL[i.kind]}: ${noDash(i.summary)} ${noDash(i.why)}`;

  const text = [
    `What happened on your watchlist since yesterday's email.`,
    "",
    ...groups.flatMap((g) => [`${g.company} (${g.symbol})`, ...g.items.map((i) => `- ${line(i)}${i.url ? ` ${i.url}` : ""}`), ""]),
    FOOTER,
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1A1640;">
<div style="max-width:640px;margin:0 auto;">
<p style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#2B2463;margin:0 0 4px;font-weight:600;">Dualis Research</p>
<h1 style="font-size:20px;margin:0 0 20px;font-weight:600;">Your watchlist, ${esc(shortDay(day))}</h1>
${groups
  .map(
    (g) => `<h2 style="font-size:16px;margin:24px 0 8px;font-weight:600;">${esc(g.company)} <span style="color:#6b6880;font-weight:400;">${esc(g.symbol)}</span></h2>
<ul style="margin:0;padding-left:18px;">
${g.items
  .map(
    (i) => `<li style="margin:0 0 10px;font-size:15px;line-height:1.5;"><strong>${KIND_LABEL[i.kind]}:</strong> ${esc(noDash(i.summary))} <span style="color:#4a4760;">${esc(noDash(i.why))}</span>${
      i.url ? ` <a href="${esc(i.url)}" style="color:#2B2463;">${esc(i.publisher ?? "Source")} &#8599;</a>` : ""
    }</li>`,
  )
  .join("\n")}
</ul>`,
  )
  .join("\n")}
<p style="font-size:12px;color:#6b6880;margin:32px 0 0;border-top:1px solid #e6e4ef;padding-top:12px;">${esc(FOOTER)}</p>
</div></body></html>`;
  return { subject, text, html };
}
