import type { RestockHint } from "./store.js";

// Soft restock hints derived from purchase cadence (see itemStatsRepo). These
// are gentle, history-based nudges — never certainties, never nags.

/** Prompt block with restock signals. "" if there are none. */
export function restockDirective(hints?: RestockHint[]): string {
  if (!hints?.length) return "";
  const lines = hints.map(
    (h) => `- ${h.name}: usually rebought about every ${h.cadence_days} days; last bought ${h.days_since_last} days ago`
  );
  return [
    "",
    "",
    "RESTOCK SIGNALS (from purchase history — soft hints, not certainties):",
    ...lines,
    "If it is relevant to what the user is asking, you MAY gently note that one of",
    "these might be running low and ask whether they want to restock. Keep it soft",
    "and brief, mention at most one, and skip it entirely if it isn't relevant.",
  ].join("\n");
}

export type { RestockHint };
