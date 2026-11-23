import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

/**
 * The email's logo: the white Solomon's knot (copy of `design/assets/Logos/dualis-mark-white.svg`) as a PNG, drawn at
 * send time and attached inline (cid), so nothing is hosted. Node only: loaded by URL from the dimension so the console
 * bundle never sees resvg.
 */
export const LOGO_CID = "dualis-mark";
export function logoPng(size = 96): string {
  const svg = readFileSync(fileURLToPath(new URL("./mark-white.svg", import.meta.url)), "utf8");
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng()).toString("base64");
}
