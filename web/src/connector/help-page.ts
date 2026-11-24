import { MCP_URL } from "./oauth";

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
<p>Nothing else to set up: Claude sends Dualis what you tell it about your stocks on its own, and answers with the Dualis analysis.</p></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
