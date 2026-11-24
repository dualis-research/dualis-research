import { MCP_URL } from "./oauth";

/** The rule Thierry pastes once in his Claude Project (the connector's own instructions say the same). */
export const PROJECT_INSTRUCTIONS =
  "Before you answer any message of mine about a stock, my watchlist or my portfolio, call the Dualis Research tool record_inputs with each question, view, analysis or piece of information I gave, in my own words, and each file of this Project you read (its name and what you read in it). Never push your own answer. " +
  "Then call get_ticker, get_watchlist or get_portfolio and answer with the Dualis analysis together with what you know from this Project. " +
  "At the start of each conversation, call list_inputs: anything in this Project's files or past conversations not pushed yet, push it all now, each with its date, without asking me.";

/**
 * What a person sees when they open the connector's address in a browser (Thierry 2026-11-21: a raw
 * {"error":"invalid_token"} read as « the website thing doesn't work »). The address only works inside Claude.
 */
export function connectorHelpPage(): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dualis Research connector</title><meta name="robots" content="noindex">
<style>body{font:17px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1a1640;max-width:620px;margin:64px auto;padding:0 24px}
h1{font-size:26px;margin:0 0 12px}h2{font-size:20px;margin:36px 0 8px}pre{background:#eeedf6;padding:14px 16px;border-radius:8px;font-family:inherit;font-size:15px;line-height:1.5;white-space:pre-wrap;user-select:all}ol{padding-left:22px}li{margin:6px 0}code{background:#eeedf6;padding:3px 7px;border-radius:5px;font-size:15px;word-break:break-all}</style></head>
<body><h1>This address goes in Claude Desktop</h1>
<p>It connects your Claude to Dualis Research. A browser cannot open it.</p>
<ol><li>Open Claude Desktop.</li><li>Settings, then Connectors, then <b>Add custom connector</b>.</li>
<li>Name: <b>Dualis Research</b>. URL: <code>${MCP_URL}</code></li><li>Click <b>Add</b>, then <b>Connect</b>, sign in, and click <b>Allow</b>.</li></ol>
<p>Then ask Claude in any chat, for example: <i>"Give me the cover of my last report for Substack"</i>.</p>
<h2>Your stocks Project</h2>
<p>Dualis learns from what you tell Claude about your stocks, and Claude answers with the Dualis analysis. Open your Project in Claude, then <b>Project instructions</b>, and paste this text:</p>
<pre>${PROJECT_INSTRUCTIONS}</pre></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
