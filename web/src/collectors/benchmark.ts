import { marketOf, suffixOf, type Market } from "./markets";

/** The S&P 500, fetched like a ticker by the price dimension (bronze, silver, gold.price_bars): the Portfolio page's benchmark. */
export const BENCHMARK = "^GSPC";

/**
 * The index of each stock's OWN market (Yahoo spelling), to take the market's move out of a stock's move
 * (Kevin 2026-11-23: Water Oasis was measured against the S&P 500). Korea splits by board: KOSDAQ for .KQ, KOSPI else.
 * A market with no free index on Yahoo falls back to the S&P 500, said by its name.
 */
const MARKET_INDEX: Record<Market, { symbol: string; name: string }> = {
  US: { symbol: "^GSPC", name: "S&P 500" },
  CA: { symbol: "^GSPTSE", name: "S&P/TSX Composite" },
  JP: { symbol: "^N225", name: "Nikkei 225" },
  KR: { symbol: "^KS11", name: "KOSPI" },
  UK: { symbol: "^FTSE", name: "FTSE 100" },
  HK: { symbol: "^HSI", name: "Hang Seng" },
  AU: { symbol: "^AXJO", name: "S&P/ASX 200" },
  EU: { symbol: "^STOXX", name: "STOXX Europe 600" },
  IL: { symbol: "^TA125.TA", name: "TA-125" },
  TW: { symbol: "^TWII", name: "TAIEX" },
  VN: { symbol: "^GSPC", name: "S&P 500" },
};
const KOSDAQ = { symbol: "^KQ11", name: "KOSDAQ" };

/** The local market index a stock is measured against. */
export function localIndex(symbol: string): { symbol: string; name: string } {
  if (suffixOf(symbol) === "KQ") return KOSDAQ;
  return MARKET_INDEX[marketOf(symbol)];
}

/** Every index the price dimension fetches: the S&P 500 plus each listed stock's local index. */
export const indexesFor = (symbols: string[]): string[] => [...new Set([BENCHMARK, ...symbols.map((s) => localIndex(s).symbol)])].sort();
