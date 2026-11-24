import type { SourceContext } from "../../types";

/** Who gets the emails (MAIL_RECIPIENTS secret: [{email, role}]): Kevin (test) AND Thierry (client), Kevin 2026-11-23. */
export const RECIPIENT_ROLES: readonly string[] = ["test", "client"];
export const MAILER_URL = "https://mailer.dualisresearch.com/send";
/** Where the email's pictures live: the mailer Worker serves the white knot and the kind icons (Gmail did not render a cid image). */
export const ASSETS_URL = "https://mailer.dualisresearch.com";

export type Recipient = { email: string; role: string };
/** The MAIL_RECIPIENTS secret: [{email, role}]. Every role asked must have a recipient (never a silent half-send). */
export function recipientsFor(env: Record<string, string | undefined>, roles: readonly string[]): string[] {
  const raw = env.MAIL_RECIPIENTS;
  if (!raw) throw new Error("MAIL_RECIPIENTS is not set");
  const list = JSON.parse(raw) as Recipient[];
  for (const role of roles) if (!list.some((r) => r.role === role)) throw new Error(`no ${role} recipient in MAIL_RECIPIENTS`);
  return [...new Set(list.filter((r) => roles.includes(r.role)).map((r) => r.email))];
}

/** Asks the `dualis-mail` Worker to send one email. Never throws on a refused send: `failed` + what it answered. */
export async function postMail(ctx: SourceContext, to: string[], email: { subject: string; text: string; html: string }): Promise<{ status: "sent" | "partial" | "failed"; response: object }> {
  if (!ctx.env.MAIL_TOKEN) throw new Error("MAIL_TOKEN is not set");
  try {
    const res = await ctx.fetch(MAILER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.env.MAIL_TOKEN}`, "Content-Type": "application/json", "User-Agent": "dualis-collector" },
      body: JSON.stringify({ to, ...email }),
    });
    const body = await res.text();
    const parsed: unknown = (() => { try { return JSON.parse(body); } catch { return body.slice(0, 2000); } })();
    const results = (parsed as { results?: { status: string }[] } | null)?.results ?? [];
    const sent = results.filter((r) => r.status === "sent").length;
    return { status: res.ok && sent === to.length ? "sent" : sent > 0 ? "partial" : "failed", response: { status: res.status, body: parsed } };
  } catch (err) {
    return { status: "failed", response: { error: (err as Error).message } };
  }
}
