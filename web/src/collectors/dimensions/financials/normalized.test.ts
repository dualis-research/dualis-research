import { describe, expect, it } from "vitest";
import { deriveMetrics } from "./derive";
import { pdfExtract } from "./sources";

/** Normalized earnings (Thierry, call 2026-11-26): a write-off last year makes this year's +40% look like +100%. */
const line = (periodEnd: string, l: string, value: number, sources = ["pdf-extract"]) => ({ periodType: "year" as const, periodEnd, line: l, value, currency: "HKD", sources });

describe("normalized net income", () => {
  it("removes the one-off items the company presents, at their pre-tax amount, and grows on that", () => {
    const m = deriveMetrics("1161.HK", [line("2024-09", "net-income", 50), line("2024-09", "one-off:Goodwill impairment", -20), line("2025-09", "net-income", 100)]);
    const norm = (pe: string) => m.find((x) => x.metric === "normalized-net-income" && x.periodEnd === pe);
    expect(norm("2024-09")?.value).toBe(70);
    expect(norm("2024-09")?.formula).toContain("Goodwill impairment");
    expect(norm("2025-09")?.value).toBe(100);
    expect(norm("2025-09")?.formula).toBe("net income, no one-off item reported for the period");
    const growth = m.find((x) => x.metric === "normalized-net-income-growth" && x.periodEnd === "2025-09");
    expect(growth?.value).toBeCloseTo(100 / 70 - 1);
  });

  it("the company's own adjusted profit wins; a period no one-off reader saw stays without a normalized figure", () => {
    const m = deriveMetrics("1161.HK", [line("2025-09", "net-income", 100), line("2025-09", "adjusted-net-income", 90), line("2025-09", "one-off:Disposal gain", 10), line("2023-09", "net-income", 40, ["yahoo"])]);
    expect(m.find((x) => x.metric === "normalized-net-income" && x.periodEnd === "2025-09")?.formula).toBe("adjusted net income as the company prints it");
    expect(m.find((x) => x.metric === "normalized-net-income" && x.periodEnd === "2023-09")).toBeUndefined();
  });

  it("the report reader keeps a one-off printed on its page, signed by its effect on profit", () => {
    const page = "Impairment loss on goodwill (12,345) Gain on disposal of a subsidiary 2,000";
    const payload = {
      version: "pdf-extract@v4",
      documents: [{ kind: "annual", version: "pdf-extract@v4", document: { title: "Annual Report 2025", url: "https://x/1.pdf", filedAt: "2025-12-18" }, pages: [{ page: 7, text: page }], model: "m",
        extraction: { currency: "HKD", oneOffs: [
          { periodEnd: "2025-09", months: 12, name: "Impairment loss on goodwill", printed: "(12,345)", unit: "thousand", page: 7, effect: "charge" },
          { periodEnd: "2025-09", months: 12, name: "Gain on disposal of a subsidiary", printed: "2,000", unit: "thousand", page: 7, effect: "gain" },
          { periodEnd: "2025-09", months: 12, name: "Invented", printed: "9,999", unit: "thousand", page: 7, effect: "charge" },
        ] } }],
    };
    const got = pdfExtract.extract(payload).map((r) => [r.line, r.value]);
    expect(got).toEqual([["one-off:Impairment loss on goodwill", -12_345_000], ["one-off:Gain on disposal of a subsidiary", 2_000_000]]);
  });
});
