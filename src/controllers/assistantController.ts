import type { Request, Response } from "express";
import {
  analyzeBasket,
  converse,
  extractItems,
  isConfigured,
  suggestBuy,
  suggestCook,
  type Item,
  type Turn,
} from "../services/assistantService.js";
import { matchOffer, type AdContext, type AdExclusions } from "../services/adService.js";
import { detectLanguage } from "../lang.js";
import type { GlossaryEntry } from "../glossary.js";
import type { PantryItem } from "../pantry.js";
import type { EquipmentItem } from "../equipment.js";
import { DEFAULT_USER_ID, equipmentRepo, glossaryRepo, itemStatsRepo, pantryRepo, purchasesRepo, recipesRepo } from "../store.js";

// Controllers own the use-case flow: validate input, load prerequisites,
// sequence domain primitives, and map failures to user-facing errors. Services
// stay as composable primitives (see assistantService.ts).
//
// The durable store (store.ts) is the source of truth for the pantry and the
// glossary — the client no longer owns them. Each flow loads them as context,
// and persists whatever the model learned this turn.

// user_id is resolved by the auth middleware (authAndUser) and attached to the
// request; fall back to the default only if a route somehow bypassed it.
function userIdOf(req: Request): number {
  return req.userId ?? DEFAULT_USER_ID;
}

/** Current durable memory the client renders. */
function stateOf(userId: number) {
  return {
    pantry: pantryRepo.list(userId),
    glossary: glossaryRepo.list(userId),
    restock: itemStatsRepo.dueForRestock(userId),
    recipes: recipesRepo.list(userId),
    equipment: equipmentRepo.list(userId),
  };
}

/** Persist whatever the model learned this turn (stated by the user). */
function persistLearned(
  userId: number,
  learned: { glossary_learned?: GlossaryEntry[]; pantry_learned?: PantryItem[]; equipment_learned?: EquipmentItem[] }
): void {
  for (const g of learned.glossary_learned ?? []) glossaryRepo.upsert(userId, g);
  for (const p of learned.pantry_learned ?? []) pantryRepo.upsert(userId, p);
  for (const e of learned.equipment_learned ?? []) equipmentRepo.upsert(userId, e);
}

// Trust firewall: the sponsored offer (MOCK) is picked only AFTER the neutral
// answer exists, from that answer plus the user's exclusions. It never feeds
// back into the advice. See adService.ts.
function attachSponsored(
  ctx: { categories: string[]; terms: string[] },
  exclusions?: AdExclusions,
  seenOfferIds?: string[]
) {
  const adCtx: AdContext = { ...ctx, exclusions, seenOfferIds };
  return matchOffer(adCtx);
}

function tokens(...parts: (string | undefined)[]): string[] {
  return parts
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .split(/[^a-zA-Zа-яА-Я0-9]+/)
    .filter((t) => t.length > 2);
}

/** POST /api/analyze — evaluate an uploaded/pasted basket. */
export async function analyzeBasketFlow(req: Request, res: Response): Promise<void> {
  if (!ensureConfigured(res)) return;

  const text: string | undefined = req.body?.text;
  const imageDataUrl: string | undefined = req.body?.imageDataUrl;

  if (!text?.trim() && !imageDataUrl) {
    res.status(400).json({ error: "Provide a basket image or a text list of items." });
    return;
  }
  if (imageDataUrl && !/^data:image\//.test(imageDataUrl)) {
    res.status(400).json({ error: "imageDataUrl must be a data:image/* URL." });
    return;
  }

  // Reply in the user's language. With an image and little/no text, default
  // (Russian) applies; any typed text overrides it.
  const language = detectLanguage(text);
  const userId = userIdOf(req);
  const glossary = glossaryRepo.list(userId);
  const pantry = pantryRepo.list(userId);
  const recipes = recipesRepo.list(userId);
  const equipment = equipmentRepo.list(userId);

  try {
    // 1) extract a product list; glossary lets canonical names match the user's terms
    const items = await extractItems({ text, imageDataUrl, language, glossary });
    if (!items.length) {
      res.status(422).json({ error: "Could not read any products. Try a clearer image or a text list." });
      return;
    }
    // 2) evaluate the basket (type, verdict, dish, buy-list); saved recipes let
    //    the model note "this looks like it's for your usual <recipe>"
    const analysis = await analyzeBasket(items, { language, glossary, pantry, recipes, equipment });

    // 3) persist: record the purchase (history), sync bought items into the
    //    pantry as observed evidence, and store anything the model learned.
    purchasesRepo.add(
      userId,
      { source_type: imageDataUrl ? "image" : "text", basket_kind: analysis.basket_kind, raw_text: text },
      items
    );
    pantryRepo.observeFromPurchase(userId, items);
    persistLearned(userId, analysis);

    // 4) MOCK ad, chosen after the answer, gated by user exclusions
    const exclusions: AdExclusions | undefined = req.body?.adExclusions;
    const seen: string[] | undefined = req.body?.adSeen;
    const sponsored = attachSponsored(
      {
        categories: items.map((i) => i.category),
        terms: tokens(analysis.dish, analysis.buy.join(" "), ...items.map((i) => i.name)),
      },
      exclusions,
      seen
    );

    res.json({ items, analysis, sponsored, state: stateOf(userId) });
  } catch (err) {
    fail(res, err);
  }
}

/** POST /api/ask — answer "what to cook?" / "what to buy?" style questions. */
export async function askFlow(req: Request, res: Response): Promise<void> {
  if (!ensureConfigured(res)) return;

  const question: string | undefined = req.body?.question;
  const items: Item[] | undefined = Array.isArray(req.body?.items) ? req.body.items : undefined;
  const forced: string | undefined = req.body?.intent; // optional override from UI buttons

  if (!question?.trim() && !forced) {
    res.status(400).json({ error: "Provide a question." });
    return;
  }

  const intent = forced ?? classifyIntent(question ?? "");

  const exclusions: AdExclusions | undefined = req.body?.adExclusions;
  const seen: string[] | undefined = req.body?.adSeen;
  const userId = userIdOf(req);
  const glossary = glossaryRepo.list(userId);
  const pantry = pantryRepo.list(userId);
  const restock = itemStatsRepo.dueForRestock(userId);
  const recipes = recipesRepo.list(userId);
  const equipment = equipmentRepo.list(userId);
  const itemCats = (items ?? []).map((i) => i.category);
  const itemNames = (items ?? []).map((i) => i.name);
  const language = detectLanguage(question);

  try {
    if (intent === "buy") {
      const result = await suggestBuy({ items, question, language, glossary, pantry, restock });
      const sponsored = attachSponsored(
        { categories: itemCats, terms: tokens(result.for_dish, result.buy.join(" "), ...itemNames) },
        exclusions,
        seen
      );
      res.json({ intent, result, sponsored, state: stateOf(userId) });
    } else {
      const result = await suggestCook({ items, question, language, glossary, pantry, restock, recipes, equipment });
      const dishNames = result.dishes?.map((d) => d.name).join(" ");
      const sponsored = attachSponsored(
        { categories: itemCats, terms: tokens(dishNames, ...itemNames) },
        exclusions,
        seen
      );
      res.json({ intent: "cook", result, sponsored, state: stateOf(userId) });
    }
  } catch (err) {
    fail(res, err);
  }
}

/**
 * POST /api/chat — continue the session about the current basket. Handles
 * follow-up questions, pantry corrections ("not sure I have oil"), and
 * preferences WITHOUT re-analyzing the message as a new basket. This is what
 * keeps the basket context across turns.
 */
export async function chatFlow(req: Request, res: Response): Promise<void> {
  if (!ensureConfigured(res)) return;

  const message: string | undefined = req.body?.message;
  const items: Item[] | undefined = Array.isArray(req.body?.items) ? req.body.items : undefined;
  const history: Turn[] | undefined = Array.isArray(req.body?.history) ? req.body.history : undefined;

  if (!message?.trim()) {
    res.status(400).json({ error: "Provide a message." });
    return;
  }
  if (!items?.length) {
    res.status(409).json({ error: "No current basket in this session. Upload or paste a basket first." });
    return;
  }

  const exclusions: AdExclusions | undefined = req.body?.adExclusions;
  const seen: string[] | undefined = req.body?.adSeen;
  const userId = userIdOf(req);
  const glossary = glossaryRepo.list(userId);
  const pantry = pantryRepo.list(userId);
  const restock = itemStatsRepo.dueForRestock(userId);
  const recipes = recipesRepo.list(userId);
  const equipment = equipmentRepo.list(userId);
  const language = detectLanguage(message);

  try {
    const result = await converse({ items, history, message, language, glossary, pantry, restock, recipes, equipment });
    persistLearned(userId, result);
    // The model recognizes a recipe on its own (no button) and dedupes against
    // saved ones; persist it when present. recipesRepo.save upserts by name.
    if (result.recipe_learned?.name?.trim()) {
      recipesRepo.save(userId, result.recipe_learned, message);
      // Equipment named in a saved recipe is evidence the user has it.
      equipmentRepo.observeFromRecipe(userId, result.recipe_learned.equipment ?? []);
    }
    const dishNames = result.dishes?.map((d) => d.name).join(" ") ?? "";
    const sponsored = attachSponsored(
      {
        categories: items.map((i) => i.category),
        terms: tokens(dishNames, (result.buy ?? []).join(" "), ...items.map((i) => i.name)),
      },
      exclusions,
      seen
    );
    res.json({ result, sponsored, state: stateOf(userId) });
  } catch (err) {
    fail(res, err);
  }
}

/** GET /api/state — the durable memory (pantry + glossary) the client renders. */
export function stateFlow(req: Request, res: Response): void {
  res.json(stateOf(userIdOf(req)));
}

/** GET /api/history — recent purchases (basket history). */
export function historyFlow(req: Request, res: Response): void {
  res.json({ purchases: purchasesRepo.recent(userIdOf(req)) });
}

/**
 * POST /api/feedback — direct user edits to durable memory: correct a product
 * (glossary), confirm/remove a pantry item. Returns the updated state.
 */
export function feedbackFlow(req: Request, res: Response): void {
  const userId = userIdOf(req);
  persistLearned(userId, {
    glossary_learned: Array.isArray(req.body?.glossaryLearned) ? req.body.glossaryLearned : undefined,
    pantry_learned: Array.isArray(req.body?.pantryLearned) ? req.body.pantryLearned : undefined,
  });
  const remove: string | undefined = req.body?.pantryRemove;
  if (remove) pantryRepo.remove(userId, remove);
  const recipeRemove: string | undefined = req.body?.recipeRemove;
  if (recipeRemove) recipesRepo.remove(userId, recipeRemove);
  const equipmentRemove: string | undefined = req.body?.equipmentRemove;
  if (equipmentRemove) equipmentRepo.remove(userId, equipmentRemove);
  res.json({ state: stateOf(userId) });
}

// Lightweight intent routing lives in the controller: it decides which domain
// primitive to compose. Buy-oriented phrasing -> shopping list; otherwise cook.
function classifyIntent(q: string): "cook" | "buy" {
  const s = q.toLowerCase();
  const buy = ["buy", "store", "shop", "grab", "pick up", "on the way", "купить", "магазин"];
  return buy.some((w) => s.includes(w)) ? "buy" : "cook";
}

function ensureConfigured(res: Response): boolean {
  if (isConfigured()) return true;
  res.status(503).json({
    error: "LLM provider is not configured. Set LLM_API_KEY (and LLM_BASE_URL) in .env.",
  });
  return false;
}

function fail(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : "Unexpected error.";
  // Surface the upstream HTTP status when the SDK provides it, and turn a
  // provider content/security block into a clear, actionable message instead of
  // a raw 502. The session survives — only this one turn failed.
  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : undefined;
  if (status === 403 || /security policy|moderat|content .*polic/i.test(message)) {
    res.status(422).json({
      error:
        "The model provider blocked this request by its content/security policy. " +
        "It's usually one specific input — try again, rephrase, or (for an image) crop/redact it or paste the items as text instead.",
    });
    return;
  }
  if (status === 401) {
    res.status(502).json({ error: "LLM auth failed (401) — the API key is invalid or revoked. Update LLM_API_KEY in .env." });
    return;
  }
  if (status === 429) {
    res.status(502).json({ error: "LLM rate limit / quota hit (429). Wait a moment or check the provider account." });
    return;
  }
  res.status(502).json({ error: `LLM request failed${status ? ` (${status})` : ""}: ${message}` });
}
