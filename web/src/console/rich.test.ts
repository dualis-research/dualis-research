import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Rich } from "./rich";

describe("Rich", () => {
  it("renders the key words in bold and never shows a lone mark", () => {
    expect(renderToStaticMarkup(h(Rich, { text: "Margin fell to **8%**, a **structural** change." }))).toBe('Margin fell to <strong class="font-semibold text-kumo-strong">8%</strong>, a <strong class="font-semibold text-kumo-strong">structural</strong> change.');
    expect(renderToStaticMarkup(h(Rich, { text: "a cut **mid" }))).toBe("a cut mid");
  });
});
