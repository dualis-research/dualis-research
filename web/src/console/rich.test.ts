import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/console/link", () => ({ default: ({ href, children }: { href: string; children: unknown }) => h("a", { href }, children as never) }));
import { ExplanationWithCitations } from "./driver-reason";
import { Rich } from "./rich";

describe("Rich", () => {
  it("renders the key words in bold and never shows a lone mark", () => {
    expect(renderToStaticMarkup(h(Rich, { text: "Margin fell to **8%**, a **structural** change." }))).toBe('Margin fell to <strong class="font-semibold text-kumo-strong">8%</strong>, a <strong class="font-semibold text-kumo-strong">structural</strong> change.');
    expect(renderToStaticMarkup(h(Rich, { text: "a cut **mid" }))).toBe("a cut mid");
  });

  it("places a quote chip on bold text and keeps the bold", () => {
    const html = renderToStaticMarkup(
      h(ExplanationWithCitations, {
        text: "Management said **orders doubled** in the year.",
        citations: [{ documentId: "d1", page: 3, quote: "orders doubled", title: "Annual report" }],
        hrefFor: (i: string) => `/x?item=${i}`,
      }),
    );
    expect(html).toContain("<strong");
    expect(html).toMatch(/p\. (<!-- -->)?3/);
    expect(html).not.toContain("**");
    expect(html.indexOf("orders doubled</strong>")).toBeLessThan(html.indexOf("Annual report"));
  });
});
