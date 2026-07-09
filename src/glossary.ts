// Personal glossary: a per-user map from the user's shorthand / ambiguous terms
// to a canonical product (a short word the user uses -> the specific product
// they mean by it). It is collected
// unobtrusively — inferred from usage and, above all, from what the user states
// or corrects — never via a form. See the design notes in the conversation.
//
// In this alpha there is no server store: the glossary lives in the browser
// session and is sent with each request as context. The model resolves terms by
// it, and returns `glossary_learned` ONLY when the user's message reveals what a
// term means to them (explicitly or by correction).

export type GlossaryEntry = {
  term: string; // user's word, lowercased
  canonical: string; // what it actually means for this user
  category?: string;
  confidence?: "low" | "medium" | "high";
  source?: "observed" | "user_confirmed" | "default";
};

/**
 * Render the glossary as a prompt block. Only medium/high-confidence entries are
 * injected silently; low-confidence ones are omitted so a single observation
 * cannot lock a meaning — they only ever bias a one-time clarifying question.
 */
export function glossaryDirective(glossary?: GlossaryEntry[]): string {
  const usable = (glossary ?? []).filter((g) => g.term && g.canonical && (g.confidence ?? "high") !== "low");
  if (!usable.length) return "";
  const lines = usable.map((g) => `- "${g.term}" means "${g.canonical}"${g.category ? ` (${g.category})` : ""}`);
  return [
    "",
    "",
    "USER GLOSSARY (how this user's shorthand maps to real products):",
    ...lines,
    "When the user uses one of these terms, resolve it to the canonical product",
    "unless the local context clearly means something else.",
  ].join("\n");
}

/**
 * Instruction used when there is no glossary yet: teach the model to still learn
 * from stated meaning / corrections, and to surface its assumption instead of
 * asking when it can.
 */
export function glossaryLearnHint(): string {
  return [
    "",
    "",
    "If the user's message reveals or corrects what an ambiguous shorthand term",
    "means to them (i.e. the user says a short or ambiguous word they use refers",
    "to a specific product), add it to",
    '"glossary_learned": [{ "term": "...", "canonical": "...", "category": "..." }].',
    "Only when stated or corrected by the user, not on a guess. When you resolve",
    "an ambiguous term yourself, name the resolved product in your reply so a",
    "wrong guess is visible and easy to correct.",
  ].join("\n");
}
