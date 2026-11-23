import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/console/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => createElement("a", { href, className }, children) }));

/** Concision (Kevin 2026-11-18): the conclusion first, everything else in closed drawers. */

describe("a claim's drawer title is its first sentence, whole", () => {
  it("splits after the first sentence, never inside a decimal or an abbreviation", async () => {
    const { leadSentence } = await import("@/console/item-detail");
    expect(leadSentence("Profit has swung hard while sales stood still. Operating income fell from 53.80B in 2021 to 15.97B in 2023.")).toEqual({
      lead: "Profit has swung hard while sales stood still.",
      rest: "Operating income fell from 53.80B in 2021 to 15.97B in 2023.",
    });
    expect(leadSentence("Revenue rose only 1.0% in 2024 and 3.8% in 2025.")).toEqual({ lead: "Revenue rose only 1.0% in 2024 and 3.8% in 2025.", rest: "" });
    const us = "Demand in the whole of the U.S. Midwest fell again. Volumes dropped 12%.";
    expect(leadSentence(us)).toEqual({ lead: us, rest: "" });
  });
});
