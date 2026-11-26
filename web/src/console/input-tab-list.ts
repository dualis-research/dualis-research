/** Tabs of the Inputs page. Plain module (not "use client"): the server page reads it. */
export const INPUT_TABS = [
  { value: "all", label: "All", kind: null },
  { value: "questions", label: "Questions", kind: "question" },
  { value: "views", label: "Views", kind: "view" },
  { value: "analyses", label: "Analyses", kind: "analysis" },
  { value: "info", label: "Info", kind: "info" },
  { value: "files", label: "Files", kind: "file" },
] as const;
export type InputTab = (typeof INPUT_TABS)[number]["value"];
