/**
 * One tested moment in one sight (Kevin 2026-11-23: « I see the graph but understand nothing »): the KPI before and
 * after as two columns, and the 5 trading days after the moment as three: the stock, its market's share of the move,
 * and what is left once the market is taken out (the figure the test reads). Plain HTML, no chart library.
 */

const num = (s: string | null) => {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const signed = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

function Columns({ title, items, scale }: { title: string; items: { label: string; value: number; text: string; tone: string }[]; scale: number }) {
  const H = 72;
  const hasNeg = items.some((i) => i.value < 0);
  const hasPos = items.some((i) => i.value > 0);
  const up = hasNeg && hasPos ? H / 2 : hasNeg ? 0 : H;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <p className="text-xs font-medium text-kumo-subtle">{title}</p>
      <div className="flex items-stretch gap-3">
        {items.map((i) => {
          const h = scale > 0 ? Math.max(2, (Math.abs(i.value) / scale) * (hasNeg && hasPos ? H / 2 : H)) : 2;
          return (
            <div key={i.label} className="flex w-16 flex-col items-center gap-1">
              <span className="text-sm font-semibold tabular" style={{ color: i.tone }}>
                {i.text}
              </span>
              <div className="relative w-full" style={{ height: H }}>
                <div className="absolute inset-x-3 border-t border-kumo-hairline" style={{ top: up }} />
                <div className="absolute inset-x-4" style={{ background: i.tone, height: h, top: i.value >= 0 ? up - h : up }} />
              </div>
              <span className="text-center text-[11px] leading-tight text-kumo-subtle">{i.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MomentCard({
  kpiName,
  from,
  to,
  change,
  stock,
  beyond,
  indexName,
  verdict,
  navy,
  green,
  red,
  grey,
}: {
  kpiName: string;
  from: string | null;
  to: string | null;
  change: string | null;
  stock: number | null;
  beyond: number | null;
  indexName: string;
  verdict: "confirms" | "invalidates" | "neutral";
  navy: string;
  green: string;
  red: string;
  grey: string;
}) {
  const a = num(from);
  const b = num(to);
  const tone = verdict === "confirms" ? green : verdict === "invalidates" ? red : grey;
  const market = stock !== null && beyond !== null ? stock - beyond : null;
  const moves = [
    ...(stock !== null ? [{ label: "Share price", value: stock, text: signed(stock), tone: grey }] : []),
    ...(market !== null ? [{ label: `Market (${indexName})`, value: market, text: signed(market), tone: grey }] : []),
    ...(beyond !== null ? [{ label: "Beyond the market", value: beyond, text: signed(beyond), tone }] : []),
  ];
  return (
    <div className="flex flex-wrap gap-8 rounded-lg p-4 ring-1 ring-kumo-hairline">
      {a !== null && b !== null ? (
        <Columns
          title={`${kpiName}${change ? ` · ${change}` : ""}`}
          scale={Math.max(Math.abs(a), Math.abs(b))}
          items={[
            { label: "Before", value: a, text: from!, tone: grey },
            { label: "After", value: b, text: to!, tone: navy },
          ]}
        />
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="text-xs font-medium text-kumo-subtle">{kpiName}</p>
          <p className="text-base text-kumo-strong">{from || to ? `${from ?? "?"} → ${to ?? "?"}${change ? ` (${change})` : ""}` : "No change"}</p>
        </div>
      )}
      {moves.length > 0 && <Columns title="Price, 5 trading days after" scale={Math.max(...moves.map((m) => Math.abs(m.value)))} items={moves} />}
    </div>
  );
}
