import { getProvider } from "../llm/index.js";
import type { ChatMessage, ContentPart } from "../llm/index.js";
import { loadPrompt, persona } from "../prompts.js";
import { languageDirective, type Lang } from "../lang.js";
import { glossaryDirective, glossaryLearnHint, type GlossaryEntry } from "../glossary.js";
import { pantryDirective, pantryLearnHint, type PantryItem } from "../pantry.js";
import { restockDirective, type RestockHint } from "../restock.js";
import { recipesDirective, type Recipe } from "../recipes.js";
import { equipmentDirective, type EquipmentItem } from "../equipment.js";
import { preferencesDirective, type Preference } from "../preferences.js";

type SystemOpts = {
  language?: Lang;
  glossary?: GlossaryEntry[];
  pantry?: PantryItem[];
  restock?: RestockHint[];
  recipes?: Recipe[];
  equipment?: EquipmentItem[];
  preferences?: Preference[];
  // Pre-rendered directive (from budget.ts) asking the model to warn + summarize
  // when the session's token budget is nearly spent. "" / undefined when not low.
  budgetNote?: string;
  // Pre-rendered directive (from tags.ts) letting the model tag the session from
  // the operator's vocabulary. "" / undefined when the vocabulary is empty.
  tagsNote?: string;
};

// Build the system message for a task: persona + task prompt + language rule +
// personal glossary (resolve the user's shorthand) + pantry (what the user has
// at home) + restock signals — each also keeps learning from what the user states.
function system(task: string, opts: SystemOpts = {}): string {
  let s = `${persona()}\n\n${loadPrompt(task)}`;
  s += dateDirective();
  if (opts.language) s += languageDirective(opts.language);
  // State directives describe what's already known; learn hints (always on) tell
  // the model to emit updates. Both are needed — a non-empty directive must not
  // suppress the learn hint, or the memory stops growing.
  s += glossaryDirective(opts.glossary) + glossaryLearnHint();
  s += pantryDirective(opts.pantry) + pantryLearnHint();
  s += restockDirective(opts.restock);
  s += recipesDirective(opts.recipes);
  s += equipmentDirective(opts.equipment);
  s += preferencesDirective(opts.preferences);
  if (opts.budgetNote) s += opts.budgetNote;
  if (opts.tagsNote) s += opts.tagsNote;
  return s;
}

// Domain primitives. Each function is one focused LLM task. The controller
// composes them into use-case flows; it does not embed these prompts itself.
//
// This is the day-1 "immediate value" layer: NO stored memory. Answers rely on
// the current input plus safe staple defaults only.

export type Item = {
  name: string; // as read from the receipt/list
  canonical: string; // brand/size-agnostic identity used to line up purchases & pantry
  edible: boolean; // is this a food/drink you can cook or eat with? (vs household/etc.)
  qty: number | null;
  unit: string | null;
  category: string;
};

export type BasketAnalysis = {
  basket_kind: "full" | "topup" | "snack" | "household" | "recipe" | "unclear";
  attribution?: "self" | "guests" | "gift" | "pet" | "one_time" | "other";
  verdict: string;
  dish: string;
  buy: string[];
  likely_at_home: string[];
  questions: string[];
  glossary_learned?: GlossaryEntry[];
  pantry_learned?: PantryItem[];
  session_summary?: string; // filled only when the token budget is low (see budget.ts)
  tags?: string[]; // vocabulary descriptors for this session (see tags.ts)
  topics?: string[]; // structural categories this answer is about (see tags.ts)
};

export type CookSuggestion = {
  reply: string;
  dishes: Array<{
    name: string;
    required: string[];
    helpful: string[];
    optional: string[];
    staples: string[];
    missing_required: string[];
  }>;
  questions: string[];
  session_summary?: string;
  tags?: string[];
  topics?: string[];
};

export type BuySuggestion = {
  reply: string;
  for_dish: string;
  buy: string[];
  likely_at_home: string[];
  questions: string[];
  session_summary?: string;
  tags?: string[];
  topics?: string[];
};

export type Turn = { role: "user" | "assistant"; text: string };

/** Keep the most recent turns that fit within a character budget (~4 chars/token). */
function windowByBudget(turns: Turn[], maxChars: number): Turn[] {
  const out: Turn[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const len = (turns[i].text?.length ?? 0) + 8; // + role label overhead
    if (total + len > maxChars && out.length) break;
    out.unshift(turns[i]);
    total += len;
  }
  return out;
}

export type ConverseResult = {
  reply: string;
  dishes?: CookSuggestion["dishes"];
  buy?: string[];
  likely_at_home?: string[];
  questions?: string[];
  glossary_learned?: GlossaryEntry[];
  pantry_learned?: PantryItem[];
  recipe_learned?: Recipe;
  equipment_learned?: EquipmentItem[];
  preference_learned?: Preference[];
  forget_last_purchase?: boolean;
  forget_pantry?: boolean; // user asked to reset the pantry / said all food is gone
  session_summary?: string;
  tags?: string[];
  topics?: string[];
};

const provider = () => getProvider();

/**
 * Ground the model in the current date (server time). Perishability and
 * seasonality reasoning both need "now": pantry item ages are given relative to
 * TODAY, and seasonal produce depends on the month.
 */
function dateDirective(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  return `\n\nTODAY: ${date} (${weekday}). Reason about seasonality and how fresh perishable items still are relative to this date.`;
}

/** Build a user turn that may carry text and an optional image (data URL). */
function userTurn(text: string, imageDataUrl?: string): ChatMessage {
  if (!imageDataUrl) return { role: "user", content: text };
  const parts: ContentPart[] = [
    { type: "text", text },
    { type: "image", dataUrl: imageDataUrl },
  ];
  return { role: "user", content: parts };
}

/** Extract a product list from a text list and/or an image. */
export async function extractItems(input: {
  text?: string;
  imageDataUrl?: string;
  language?: Lang;
  glossary?: GlossaryEntry[];
}): Promise<Item[]> {
  const messages: ChatMessage[] = [
    // Glossary is passed so the canonical names align with the user's own terms.
    { role: "system", content: system("extract-items", { language: input.language, glossary: input.glossary }) },
    userTurn(input.text?.trim() || "Extract items from the attached image.", input.imageDataUrl),
  ];
  const out = await provider().completeJSON<{ items?: Item[] }>(messages, { temperature: 0.1 });
  // Canonical is the identity used for pantry/cadence; fall back to the raw name.
  // edible defaults to true unless the model explicitly marks it non-food.
  return (out.items ?? []).map((it) => ({
    ...it,
    canonical: (it.canonical || it.name || "").trim(),
    edible: it.edible !== false,
  }));
}

/** Evaluate a basket: type, verdict, one dish, buy-list, at-home staples. */
export async function analyzeBasket(
  items: Item[],
  opts: { language?: Lang; glossary?: GlossaryEntry[]; pantry?: PantryItem[]; recipes?: Recipe[]; equipment?: EquipmentItem[]; preferences?: Preference[]; budgetNote?: string; tagsNote?: string } = {}
): Promise<BasketAnalysis> {
  const messages: ChatMessage[] = [
    { role: "system", content: system("analyze-basket", opts) },
    { role: "user", content: `Items:\n${JSON.stringify(items, null, 2)}` },
  ];
  return provider().completeJSON<BasketAnalysis>(messages, { temperature: 0.4 });
}

/** Suggest what to cook from a (recent) item list and a free-text question. */
export async function suggestCook(input: {
  items?: Item[];
  question?: string;
  history?: Turn[];
  language?: Lang;
  glossary?: GlossaryEntry[];
  pantry?: PantryItem[];
  restock?: RestockHint[];
  recipes?: Recipe[];
  equipment?: EquipmentItem[];
  preferences?: Preference[];
  budgetNote?: string;
  tagsNote?: string;
}): Promise<CookSuggestion> {
  const ctx = contextBlock(input.items, input.question, input.history);
  const messages: ChatMessage[] = [
    { role: "system", content: system("suggest-cook", { language: input.language, glossary: input.glossary, pantry: input.pantry, restock: input.restock, recipes: input.recipes, equipment: input.equipment, preferences: input.preferences, budgetNote: input.budgetNote, tagsNote: input.tagsNote }) },
    { role: "user", content: ctx },
  ];
  return provider().completeJSON<CookSuggestion>(messages, { temperature: 0.5 });
}

/** Suggest a short "what to buy on the way home" list. */
export async function suggestBuy(input: {
  items?: Item[];
  question?: string;
  history?: Turn[];
  language?: Lang;
  glossary?: GlossaryEntry[];
  pantry?: PantryItem[];
  restock?: RestockHint[];
  budgetNote?: string;
  tagsNote?: string;
}): Promise<BuySuggestion> {
  const ctx = contextBlock(input.items, input.question, input.history);
  const messages: ChatMessage[] = [
    { role: "system", content: system("suggest-buy", { language: input.language, glossary: input.glossary, pantry: input.pantry, restock: input.restock, budgetNote: input.budgetNote, tagsNote: input.tagsNote }) },
    { role: "user", content: ctx },
  ];
  return provider().completeJSON<BuySuggestion>(messages, { temperature: 0.5 });
}

/**
 * Continue the session about the CURRENT basket: answer questions, apply pantry
 * corrections, respect preferences — without re-analyzing the message as a new
 * basket. Carries the recognized basket and a short conversation history.
 */
export async function converse(input: {
  items: Item[];
  history?: Turn[];
  message: string;
  language?: Lang;
  glossary?: GlossaryEntry[];
  pantry?: PantryItem[];
  restock?: RestockHint[];
  recipes?: Recipe[];
  equipment?: EquipmentItem[];
  preferences?: Preference[];
  budgetNote?: string;
  tagsNote?: string;
}): Promise<ConverseResult> {
  // Dialog is short-term working context only — the durable facts (pantry,
  // recipes, equipment, preferences, ...) are already extracted into memory. So
  // we keep just a recent WINDOW bounded by a character budget (~a few hundred
  // tokens), not a fixed turn count. Older turns fall off; nothing important
  // depends on them.
  const history = windowByBudget(input.history ?? [], 4000)
    .map((t) => `${t.role}: ${t.text}`)
    .join("\n");
  const ctx = [
    `Current basket:\n${JSON.stringify(input.items, null, 2)}`,
    history ? `Conversation so far:\n${history}` : "",
    `User's new message: ${input.message.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const messages: ChatMessage[] = [
    { role: "system", content: system("converse", { language: input.language, glossary: input.glossary, pantry: input.pantry, restock: input.restock, recipes: input.recipes, equipment: input.equipment, preferences: input.preferences, budgetNote: input.budgetNote, tagsNote: input.tagsNote }) },
    { role: "user", content: ctx },
  ];
  return provider().completeJSON<ConverseResult>(messages, { temperature: 0.4 });
}

export type MessageIntent = "basket" | "cook" | "buy" | "chat";

/**
 * Classify a free-text message into ONE intent (basket | cook | buy | chat).
 * A lean, persona-free task: only the classifier prompt + language rule, so the
 * decision isn't biased by the assistant persona. Temperature 0 for stability;
 * defaults to "chat" if the model returns anything unexpected.
 */
export async function classifyMessage(input: {
  text: string;
  hasBasket: boolean;
  language?: Lang;
}): Promise<MessageIntent> {
  let sys = loadPrompt("classify-message");
  if (input.language) sys += languageDirective(input.language);
  const messages: ChatMessage[] = [
    { role: "system", content: sys },
    {
      role: "user",
      content: `Basket exists this session: ${input.hasBasket ? "yes" : "no"}\n\nMessage: ${input.text.trim()}`,
    },
  ];
  const out = await provider().completeJSON<{ intent?: string }>(messages, { temperature: 0 });
  const intent = out.intent;
  return intent === "basket" || intent === "cook" || intent === "buy" ? intent : "chat";
}

function contextBlock(items?: Item[], question?: string, history?: Turn[]): string {
  const parts: string[] = [];
  if (items?.length) parts.push(`Recent items:\n${JSON.stringify(items, null, 2)}`);
  // Carry the recent dialog so multi-turn buy/cook keeps the target dish and any
  // "I'm out of X" the user just stated — bounded like converse's window.
  if (history?.length) {
    const dialog = windowByBudget(history, 4000)
      .map((t) => `${t.role}: ${t.text}`)
      .join("\n");
    if (dialog) parts.push(`Conversation so far:\n${dialog}`);
  }
  parts.push(`User question: ${question?.trim() || "(none)"}`);
  return parts.join("\n\n");
}

export function isConfigured(): boolean {
  return provider().isConfigured();
}
