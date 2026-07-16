import { pantryRepo, settingsRepo } from "./store.js";

// Interest & session tags — the neutral signal the assistant emits INSTEAD of
// selecting ads. The assistant never sees offers; the orchestrator (bot/app)
// maps these tags to whatever it wants (ads, personalization, analytics). This
// keeps the assistant a neutral food core with no monetization logic in it.
//
// Two layers:
//   - STRUCTURAL categories (meat|vegetable|dairy|...): the stable backbone,
//     code-owned (also used by extraction/pantry). Always valid, not editable.
//   - DESCRIPTOR tags (dinner|low-sugar|quick|...): an abstract, culture-agnostic
//     vocabulary the operator manages at runtime via the admin API, so the bot
//     and the assistant stay consistent. The LLM may only emit tags from it.

// Categories that must never be advertised/targeted (safety) — surfaced as
// `excluded` so the orchestrator's matcher skips them.
const PROHIBITED_ALWAYS = ["alcohol", "tobacco"];

// Structural food categories — the code-owned backbone (kept in sync with the
// "category" enum in lang.ts). The model tags a session's *topic* with these so
// ads/personalization follow what the conversation is about, not what happens to
// sit in the basket (a basket may be an already-completed purchase).
export const STRUCTURAL_CATEGORIES = [
  "meat",
  "fish",
  "vegetable",
  "fruit",
  "dairy",
  "grain",
  "bread",
  "drink",
  "water",
  "sweet",
  "snack",
  "household",
  "condiment",
  "other",
] as const;

// Seed descriptor vocabulary (abstract, no ingredients or per-culture rules).
// Overridable at runtime; the operator can add/remove freely.
const DEFAULT_DESCRIPTORS = [
  "breakfast",
  "lunch",
  "dinner",
  "snack-time",
  "quick",
  "budget",
  "batch-cook",
  "fresh-side",
  "low-sugar",
  "high-protein",
  "vegetarian-meal",
  "comfort-food",
];

const VOCAB_KEY = "tag_vocabulary";

const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();
const uniq = (xs: string[]): string[] => [...new Set(xs.filter(Boolean))];

/** The editable descriptor vocabulary (stored setting over the seed default). */
export function tagVocabulary(): string[] {
  const raw = settingsRepo.get(VOCAB_KEY);
  if (!raw) return DEFAULT_DESCRIPTORS;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : DEFAULT_DESCRIPTORS;
  } catch {
    return DEFAULT_DESCRIPTORS;
  }
}

/**
 * Replace the descriptor vocabulary (admin). Normalizes to lowercase, trims,
 * dedupes, drops empties, and caps size/length so a bad payload can't bloat the
 * prompt. Returns the stored vocabulary.
 */
export function setTagVocabulary(list: unknown): string[] {
  const arr = Array.isArray(list) ? list : [];
  const cleaned = uniq(
    arr.filter((t) => typeof t === "string").map(norm).filter((t) => t.length > 0 && t.length <= 40)
  ).slice(0, 100);
  settingsRepo.set(VOCAB_KEY, JSON.stringify(cleaned));
  return cleaned;
}

/**
 * System-prompt block letting the model tag the session. Always asks for the
 * `topics` (structural categories the conversation is about, so targeting
 * follows context, not the basket); additionally asks for descriptor `tags`
 * when a vocabulary is configured.
 */
export function tagsDirective(vocab: string[]): string {
  const lines = [
    "",
    "",
    'SESSION TOPICS: add a "topics" array to the JSON you return — the food',
    "categories THIS conversation/answer is about (what the user is asking for or",
    "discussing right now), even if nothing is in the basket. Choose ONLY from",
    "this exact list, verbatim; use [] if none fit and never invent categories:",
    STRUCTURAL_CATEGORIES.join(", "),
  ];
  if (vocab.length) {
    lines.push(
      "",
      'SESSION TAGS: also add a "tags" array — 0 to 4 tags that describe the',
      "session's angle (meal timing, intent, dietary angle). Choose ONLY from this",
      "exact list, verbatim; use [] if none fit and never invent tags:",
      vocab.join(", "),
    );
  }
  return lines.join("\n");
}

/** Keep only LLM-emitted tags that are in the current vocabulary. */
export function filterDescriptors(raw: unknown, vocab: string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(vocab.map(norm));
  return uniq(raw.map(norm).filter((t) => allowed.has(t)));
}

/** Keep only LLM-emitted topics that are valid structural categories. */
export function filterCategories(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(STRUCTURAL_CATEGORIES.map(norm));
  return uniq(raw.map(norm).filter((c) => allowed.has(c)));
}

export type Tags = { interests: string[]; session: string[]; excluded: string[] };

/**
 * Assemble the neutral tag signal:
 *  - interests: durable categories from the pantry (what's usually at home);
 *  - session:   categories the current answer is ABOUT (topics) + the LLM's
 *               vocabulary tags — driven by the conversation, not the basket;
 *  - excluded:  always-prohibited categories (the bot layers user prefs on top).
 * Deterministic; no LLM here (the descriptors were already produced upstream).
 */
export function buildTags(userId: number, opts: { sessionCategories?: string[]; descriptors?: string[] }): Tags {
  const interests = uniq(pantryRepo.list(userId).map((p) => norm(p.category)));
  const session = uniq([...(opts.sessionCategories ?? []).map(norm), ...(opts.descriptors ?? [])]);
  return { interests, session, excluded: [...PROHIBITED_ALWAYS] };
}
