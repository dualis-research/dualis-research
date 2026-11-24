"use client";

import { Tabs } from "@cloudflare/kumo";
import { useRouter } from "next/navigation";

export const INPUT_TABS = [
  { value: "all", label: "All", kind: null },
  { value: "questions", label: "Questions", kind: "question" },
  { value: "views", label: "Views", kind: "view" },
  { value: "analyses", label: "Analyses", kind: "analysis" },
  { value: "info", label: "Info", kind: "info" },
  { value: "files", label: "Files", kind: "file" },
] as const;
export type InputTab = (typeof INPUT_TABS)[number]["value"];

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
