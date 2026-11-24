import { describe, expect, it } from "vitest";
import { isUsageLimit } from "./usage-limit";

describe("isUsageLimit", () => {
  it("reads the subscription's limit message, never another failure", () => {
    expect(isUsageLimit("Claude call failed: You've hit your 5-hour limit · resets 3:10pm (UTC)")).toBe(true);
    expect(isUsageLimit("Claude call failed: You've hit your weekly limit")).toBe(true);
    expect(isUsageLimit("key points: expected 3 bullets, got 2")).toBe(false);
    expect(isUsageLimit(null)).toBe(false);
  });
});
