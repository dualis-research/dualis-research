import { eq, sql } from "drizzle-orm";
import { companyProfiles } from "@/db/schema/gold";
import * as silver from "@/db/schema/silver";
import type { Db } from "@/db/types";

/** Active tickers with their company name, logo and what they do; portfolio first, then by symbol. */
export async function watched(db: Db) {
  const rows = await db
    .select({ symbol: silver.tickers.symbol, inPortfolio: silver.tickers.inPortfolio, name: companyProfiles.name, about: companyProfiles.description, logo: companyProfiles.logoUrl })
    .from(silver.tickers)
    .leftJoin(companyProfiles, eq(companyProfiles.symbol, silver.tickers.symbol))
    .where(sql`${silver.tickers.active}`);
  return rows.sort((a, b) => Number(b.inPortfolio) - Number(a.inPortfolio) || a.symbol.localeCompare(b.symbol));
}
