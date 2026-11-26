# Dualis signal architecture (FINAL, Kevin 2026-11-25)

This is the ONE architecture of the analysis. It replaces every earlier design (narrative drivers, rationale, research
report, evidence, narrative-since, thesis, two theses, test C...). It is not re-discussed: every page, panel, prompt and
table reflects these steps and nothing else. Anything in the code or the docs that does not map to a step below is
deleted. Kevin's words: « Voici les uniques étapes, tout le reste est à jeter… Qu'on ne le remette plus en question. Que
toutes les pages soient une réflexion de ces étapes. »

## Common objects (inputs, stored bronze / silver / gold)
- **Events**: company news, industry news, releases (results, filings), 10 years (Thierry 2026-11-26: « we just do it 10 years for every stock »; `HISTORY_YEARS`).
- **Thierry's inputs**: what his Claude Desktop shares (opinions, analyses, questions), `gold.thierry_inputs`.
- **Prices**: per ticker, 10 years of daily closes + the unbiased version (the market's move taken out).
- **Fundamental KPIs**: the company's figures; may include a policy when it can happen again (e.g. a cut in a given
  metric).
- **Fair value** and its range, per ticker.
- **Tickers**: the portfolio and the watchlist.

## A. Price Driver Candidates (PDC)
- For each ticker.
- Check every event of the ticker (its industry included).
- For each event, check whether the 1 week after it was a significant unbiased price move.
- Each time there is a significant move, the LLM reads the associated event and deduces from it a list of fundamental
  KPIs that may have driven the move.
- Output: the list of PDCs of the ticker.

## B. Price Drivers (PD)
- For each significant 1-week price move (checked every day): did the PDC change significantly on the first day of that
  1-week bar?
- For each significant change of the PDC: was the 1 week after that day a significant unbiased price move?
- All of it is given as context to the LLM, which deduces a confidence level that the PDC is a PD: strong | weak |
  noise.

## C. Narrative
- Given the current price, the fair value and Thierry's notes: do we think the market holds a narrative that explains
  why the stock sits below its fair value? Above it? With what confidence (strong | weak | noise)?
- If weak or strong: which PDs explain it?

## D. Reversal (only when the narrative confidence is weak or strong)
- Given the narrative and each PD: is the PD's value in continuation (weak | strong), in reversal (weak | strong), or
  noise?

## E. Signal (per ticker): Narrative Reversal
- Given C and D: is the narrative turning? Confidence strong | weak | noise.

## Additions agreed by Kevin (2026-11-25)
1. **D, leading indicators**: besides the PD's own value, a recent event announcing that the PD will change soon
   (« Lunar New Year bookings full » ahead of Water Oasis's next half) counts in the reversal (Thierry 2026-11-23:
   « a change of a PD or a leading indicator of it »).
2. **Thierry's inputs in every LLM step (A to E)**, for the tickers they name, as context the LLM weighs, never an
   override (Kevin 2026-11-24).
3. **Outputs outside the chain, kept as readers of these objects only**: the WhatsApp alert on a strong signal (E), the
   morning and critical emails (a separate product, Thierry 2026-11-23), the content (Ideas, drafts, pictures, Sandbox).
   They never add a step or a judgment of their own on the analysis.

**Rejected (Kevin 2026-11-25, never re-propose)**: a « fundamental or macro? » filter on the moves. « If the unbiased
price moves then there is a valid price driver »: a significant unbiased move always yields PDCs, an industry news
(« Hong Kong retail sector under pressure ») is a valid one. No per-week fundamental / market / unknown verdict.

## Rules that apply to every step
- Each step is stored (bronze raw answer, silver canonical, gold what pages read), one stored judgment per input,
  provenance kept, every claim one click from its source.
- The LLM decides every judgment; no hard-coded threshold or rule unless Kevin asks for one.
- The pages show these steps in this order (A, B, C, D, E), each closed by default, its title carrying its conclusion.
