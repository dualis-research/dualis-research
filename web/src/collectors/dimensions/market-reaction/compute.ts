/** Shared shapes of market-reaction: a daily close and the fair value as it stood on a day. */

export type Bar = { date: string; close: number };
export type FvPoint = { day: string; value: number; low: number | null; high: number | null };
