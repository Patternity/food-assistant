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
  edible?: boolean; // false for non-food (household/etc.) — kept, but not cooked with
  updated_at?: string; // ISO; for observed items ~ purchase time, used for recency
};

function daysAgo(iso?: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 86_400_000));
}

/** Prompt block describing what the user has / hasn't at home. "" if empty. */
export function pantryDirective(pantry?: PantryItem[]): string {
  const items = pantry ?? [];
  const avail = items.filter((p) => p.name && (p.state ?? "available") === "available");
  const confirmed = avail.filter((p) => p.source === "user_confirmed");
  const observed = avail.filter((p) => p.source !== "user_confirmed");
  const missing = items.filter((p) => p.name && p.state === "missing");
  if (!avail.length && !missing.length) return "";
  const lines: string[] = ["", "", "PANTRY (what the user has at home):"];
  if (confirmed.length) {
    const withAge = confirmed.map((p) => {
      const d = daysAgo(p.updated_at);
      return d === null ? p.name : `${p.name} (said ~${d} day${d === 1 ? "" : "s"} ago)`;
    });
    lines.push(`- confirmed at home (high confidence): ${withAge.join(", ")}`);
  }
  if (observed.length) {
    const withAge = observed.map((p) => {
      const d = daysAgo(p.updated_at);
      return d === null ? p.name : `${p.name} (bought ~${d} day${d === 1 ? "" : "s"} ago)`;
    });
    lines.push(`- recently bought, probably still at home (lower confidence, may have been used): ${withAge.join(", ")}`);
  }
  if (missing.length) lines.push(`- used up / not at home: ${missing.map((p) => p.name).join(", ")}`);
  lines.push(
    "Use at-home items in dishes and list them under likely_at_home; never put",
    "them on the buy list. Judge freshness from how long ago each item was noted",
    "(see TODAY) and how perishable it is: even a confirmed perishable — fish,",
    "meat, greens, dairy, ripe produce — stated many days ago may no longer be good,",
    "so flag it (\"you said you had fish ~6 days ago; unless frozen, it's likely past",
    "its best\") rather than assuming it's fresh. Long-keeping staples (pasta, rice,",
    "canned goods) stay reliable. For recently-bought items speak with a little more",
    "caution. Do not assume the used-up items are available."
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
    "",
    "POSSESSION vs INTENTION: mark an item \"available\" ONLY when the user states or",
    "clearly implies they ALREADY HAVE it at home. A wish, plan, or request to COOK",
    "or BUY something (e.g. \"I want to make fish tonight\", \"what should I grab for X\")",
    "is NOT possession — do not record the target dish or its ingredients as at home.",
    "If anything, a dish the user wants to make, or an ingredient they ask about",
    "buying, is likely something they still need. When possession is simply unknown,",
    "record nothing for that item (neither available nor missing).",
  ].join("\n");
}
