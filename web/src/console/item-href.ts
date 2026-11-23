import type { ThesisSide } from "@/db/schema/analysis";

/** An item of the Analysis page (`?item=`); `thesis` keeps the shown thesis behind the item's panel. No server import: charts (client) build these too. */
export const itemHref = (symbol: string, item: string, thesis?: ThesisSide | null) => `/tickers/${encodeURIComponent(symbol)}?item=${encodeURIComponent(item)}${thesis ? `&thesis=${thesis}` : ""}`;
