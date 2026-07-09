// Pantry: what the user has (or no longer has) at home — the "what's at home"
// memory. In this alpha it lives in the browser session (localStorage), but it
// is the in-session slice of a durable pantry memory that, later, persists
// server-side per user and is fed from THREE sources, exactly like baskets and
// receipts are stored:
//   - explicit statements ("дома есть гречка / сливочное масло")  -> user_confirmed
//   - purchases from baskets / receipts (bought -> probably home) -> observed
//   - corrections ("уже съел", "закончилось")                     -> missing
// The type below already carries source/confidence so moving to a persistent,
// probabilistic pantry does not require reshaping the data.
//
// Collected unobtrusively, like the glossary: the model emits `pantry_learned`
// from what the user states; the client accumulates it and sends it back as
// context. Prompts treat available items as on hand, use them in dishes, and
// never put them on the buy list.

export type PantryItem = {
  name: string;
  category?: string;
  state?: "available" | "missing"; // default "available"
  source?: "user_confirmed" | "observed"; // forward-compat for the durable pantry
  confidence?: "low" | "medium" | "high";
};

/** Prompt block describing what the user has / hasn't at home. "" if empty. */
export function pantryDirective(pantry?: PantryItem[]): string {
  const items = pantry ?? [];
  const available = items.filter((p) => p.name && (p.state ?? "available") === "available");
  const missing = items.filter((p) => p.name && p.state === "missing");
  if (!available.length && !missing.length) return "";
  const lines: string[] = ["", "", "CONFIRMED PANTRY (stated by the user this session):"];
  if (available.length) lines.push(`- at home: ${available.map((p) => p.name).join(", ")}`);
  if (missing.length) lines.push(`- used up / not at home: ${missing.map((p) => p.name).join(", ")}`);
  lines.push(
    "Treat the at-home items as on hand (high confidence): use them in dishes and",
    "list them under likely_at_home; never put them on the buy list. Do not assume",
    "the used-up items are available."
  );
  return lines.join("\n");
}

/** Always-on instruction to keep learning the pantry from the user's statements. */
export function pantryLearnHint(): string {
  return [
    "",
    "",
    "MEMORY — WHAT'S AT HOME: Infer from the MEANING of the message whether the",
    "user already has, or has run out of, an item at home. Do not rely on any",
    "fixed wording — the user may say it directly or only imply it, in any phrasing",
    "or language (e.g. mentioning a leftover, that something is in the cupboard, or",
    "that they need not buy it because they still have it). Whenever you understand",
    "that the user has or lacks something at home, record EACH such item in",
    '"pantry_learned": [{ "name": "...", "category": "...", "state": "available|missing" }].',
    "This is separate from assumed staples. Never invent items the user did not",
    "mention or imply.",
  ].join("\n");
}
