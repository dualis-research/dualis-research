"use client";

import { Tabs } from "@cloudflare/kumo";
import { useRouter } from "next/navigation";
import { INPUT_TABS, type InputTab } from "./input-tab-list";

/** All (default) or one kind of input; kept in the URL (`?tab=`) so the view is linkable. */
export function InputsTabs({ value, counts }: { value: InputTab; counts: Record<InputTab, number> }) {
  const router = useRouter();
  return (
    <Tabs
      variant="underline"
      value={value}
      onValueChange={(v) => router.replace(v === "all" ? "/inputs" : `/inputs?tab=${v}`, { scroll: false })}
      tabs={INPUT_TABS.map((t) => ({ value: t.value, label: `${t.label} · ${counts[t.value]}` }))}
    />
  );
}
