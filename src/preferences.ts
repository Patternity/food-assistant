// User preferences: standing wishes and constraints that aren't about a specific
// product identity — "не люблю молочку", "не предлагай рыбу", "готовлю на двоих",
// dietary limits. These are the durable slice that used to live only in the
// dialog window; extracting them here means nothing important depends on how long
// the conversation is. Collected unobtrusively (from what the user states), like
// the glossary/pantry/recipes/equipment, never via a form.

export type Preference = {
  text: string; // human-readable, in the user's language
  kind?: string; // coarse tag: dislike | avoid | diet | household | other
  state?: "active" | "dropped"; // default active
  source?: "user_confirmed";
};

/** Prompt block listing the user's standing preferences. "" if none. */
export function preferencesDirective(prefs?: Preference[]): string {
  const active = (prefs ?? []).filter((p) => p.text && (p.state ?? "active") === "active");
  if (!active.length) return "";
  return [
    "",
    "",
    "USER PREFERENCES (standing wishes — honor them in every suggestion):",
    ...active.map((p) => `- ${p.text}`),
    "Never violate these. If a preference says not to suggest something, never",
    "suggest it. If one conflicts with an idea you had, drop the idea.",
  ].join("\n");
}
