/**
 * The subscription's usage limit (« You've hit your 5-hour limit · resets 3:10pm »): the call never reached the model,
 * so a retry budget must not count it (2026-11-24: three hourly runs during one limit gave up today's key points).
 */
export const isUsageLimit = (error: string | null | undefined): boolean => !!error && /hit your .*limit/i.test(error);

