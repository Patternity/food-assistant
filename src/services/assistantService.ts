import { getProvider } from "../llm/index.js";
import type { ChatMessage, ContentPart } from "../llm/index.js";
import { loadPrompt, persona } from "../prompts.js";
import { languageDirective, type Lang } from "../lang.js";
import { glossaryDirective, glossaryLearnHint, type GlossaryEntry } from "../glossary.js";
import { pantryDirective, pantryLearnHint, type PantryItem } from "../pantry.js";
import { restockDirective, type RestockHint } from "../restock.js";
import { recipesDirective, type Recipe } from "../recipes.js";
import { equipmentDirective, type EquipmentItem } from "../equipment.js";

type SystemOpts = {
  language?: Lang;
  glossary?: GlossaryEntry[];
  pantry?: PantryItem[];
  restock?: RestockHint[];
  recipes?: Recipe[];
  equipment?: EquipmentItem[];
};

// Build the system message for a task: persona + task prompt + language rule +
// personal glossary (resolve the user's shorthand) + pantry (what the user has
// at home) + restock signals — each also keeps learning from what the user states.
function system(task: string, opts: SystemOpts = {}): string {
  let s = `${persona()}\n\n${loadPrompt(task)}`;
  if (opts.language) s += languageDirective(opts.language);
  // State directives describe what's already known; learn hints (always on) tell
  // the model to emit updates. Both are needed — a non-empty directive must not
  // suppress the learn hint, or the memory stops growing.
  s += glossaryDirective(opts.glossary) + glossaryLearnHint();
  s += pantryDirective(opts.pantry) + pantryLearnHint();
  s += restockDirective(opts.restock);
  s += recipesDirective(opts.recipes);
  s += equipmentDirective(opts.equipment);
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
};

export type BuySuggestion = {
  reply: string;
  for_dish: string;
  buy: string[];
  likely_at_home: string[];
  questions: string[];
};

export type Turn = { role: "user" | "assistant"; text: string };

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
  forget_last_purchase?: boolean;
};

const provider = () => getProvider();

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
  opts: { language?: Lang; glossary?: GlossaryEntry[]; pantry?: PantryItem[]; recipes?: Recipe[]; equipment?: EquipmentItem[] } = {}
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
  language?: Lang;
  glossary?: GlossaryEntry[];
  pantry?: PantryItem[];
  restock?: RestockHint[];
  recipes?: Recipe[];
  equipment?: EquipmentItem[];
}): Promise<CookSuggestion> {
  const ctx = contextBlock(input.items, input.question);
  const messages: ChatMessage[] = [
    { role: "system", content: system("suggest-cook", { language: input.language, glossary: input.glossary, pantry: input.pantry, restock: input.restock, recipes: input.recipes, equipment: input.equipment }) },
    { role: "user", content: ctx },
  ];
  return provider().completeJSON<CookSuggestion>(messages, { temperature: 0.5 });
}

/** Suggest a short "what to buy on the way home" list. */
export async function suggestBuy(input: {
  items?: Item[];
  question?: string;
  language?: Lang;
  glossary?: GlossaryEntry[];
  pantry?: PantryItem[];
  restock?: RestockHint[];
}): Promise<BuySuggestion> {
  const ctx = contextBlock(input.items, input.question);
  const messages: ChatMessage[] = [
    { role: "system", content: system("suggest-buy", { language: input.language, glossary: input.glossary, pantry: input.pantry, restock: input.restock }) },
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
}): Promise<ConverseResult> {
  const history = (input.history ?? [])
    .slice(-8)
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
    { role: "system", content: system("converse", { language: input.language, glossary: input.glossary, pantry: input.pantry, restock: input.restock, recipes: input.recipes, equipment: input.equipment }) },
    { role: "user", content: ctx },
  ];
  return provider().completeJSON<ConverseResult>(messages, { temperature: 0.4 });
}

function contextBlock(items?: Item[], question?: string): string {
  const parts: string[] = [];
  if (items?.length) parts.push(`Recent items:\n${JSON.stringify(items, null, 2)}`);
  parts.push(`User question: ${question?.trim() || "(none)"}`);
  return parts.join("\n\n");
}

export function isConfigured(): boolean {
  return provider().isConfigured();
}
