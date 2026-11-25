/** "Weak BUY" / "No signal": a signal in the words the console shows (Kevin 2026-11-25). */
export function signalWordsOf(signal: string, strength: string): string {
  if (signal === "none") return "No signal";
  return `${strength === "strong" ? "Strong" : "Weak"} ${signal}`;
}
