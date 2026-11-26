/**
 * How far back the analysis reads, ONE figure for every window (Thierry, call 2026-11-26: « we just do it 10 years
 * for every stock »; before, 3 years of events and moves and 5 of figures and filings, which missed Water Oasis's
 * dividend cut around 2020): prices and their significant unbiased moves, events (news, filings, releases), report
 * texts and financial statements, the Price Driver tests. A source that keeps less (TDnet PDFs ~1 month, Yahoo
 * fundamentals ~4 years) gives what it has; the backlog of read-once windows drains over a few runs.
 */
export const HISTORY_YEARS = 10;
