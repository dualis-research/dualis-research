import { Badge } from "@cloudflare/kumo";
import type { ConfidenceLevel } from "@/db/schema/analysis";

const WORD: Record<ConfidenceLevel, string> = { strong: "Strong driver", weak: "Weak driver", noise: "Noise" };
const VARIANT = { strong: "success", weak: "warning", noise: "neutral" } as const;

/** Step B's confidence that a Price Driver Candidate is a Price Driver: does the market trade the stock on it? */
export function ConfidenceBadge({ level }: { level: ConfidenceLevel | null }) {
  if (!level) return <span className="text-sm text-kumo-subtle">Not tested yet</span>;
  return (
    <Badge appearance="dot" variant={VARIANT[level]}>
      {WORD[level]}
    </Badge>
  );
}
