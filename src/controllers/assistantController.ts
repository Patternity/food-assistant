import type { Request, Response } from "express";
import {
  analyzeBasket,
  classifyMessage,
  converse,
  extractItems,
  isConfigured,
  suggestBuy,
  suggestCook,
  type Item,
  type Turn,
} from "../services/assistantService.js";
import { matchOffer, type AdContext, type AdExclusions } from "../services/adService.js";
import { budgetDirective, budgetHardStopText, dayKey, SESSION_TTL_MS, viewFromUsage, WARN_RATIO, type BudgetView } from "../budget.js";
import { withUsage } from "../usage.js";
import { detectLanguage, type Lang } from "../lang.js";
import type { GlossaryEntry } from "../glossary.js";
import type { PantryItem } from "../pantry.js";
import type { EquipmentItem } from "../equipment.js";
import type { Preference } from "../preferences.js";
import { DEFAULT_USER_ID, equipmentRepo, glossaryRepo, itemStatsRepo, pantryRepo, preferencesRepo, purchasesRepo, recipesRepo, sessionsRepo, usageRepo } from "../store.js";

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
    preferences: preferencesRepo.list(userId),
  };
}

/** Persist whatever the model learned this turn (stated by the user). */
function persistLearned(
  userId: number,
  learned: {
    glossary_learned?: GlossaryEntry[];
    pantry_learned?: PantryItem[];
    equipment_learned?: EquipmentItem[];
    preference_learned?: Preference[];
  }
): void {
  for (const g of learned.glossary_learned ?? []) glossaryRepo.upsert(userId, g);
  for (const p of learned.pantry_learned ?? []) pantryRepo.upsert(userId, p);
  for (const e of learned.equipment_learned ?? []) equipmentRepo.upsert(userId, e);
  for (const pref of learned.preference_learned ?? []) preferencesRepo.upsert(userId, pref);
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

// The bot signals the session with a simple flag; there is only ever one active
// session per user. "open" forces a fresh session (entering the mode / tapping
// "new session"); absent means continue the current one (auto-opening if none is
// active or the previous went idle). "close" is handled by sessionFlow.
function forceNewSession(req: Request): boolean {
  const s = String(req.body?.session ?? "").toLowerCase();
  return s === "open" || req.body?.newSession === true;
}

/** Current budget state, reading the active session + the daily counter. */
function budgetOf(userId: number, sessionTokens: number): BudgetView {
  return viewFromUsage(sessionTokens, usageRepo.get("day", dayKey(userId)));
}

// Error a flow can throw INSIDE the usage scope to return a specific HTTP status
// (e.g. 422 "couldn't read products") — mapped to the response in fail().
class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

type BudgetGate =
  | { blocked: true }
  | { blocked: false; userId: number; budgetNote: string };

/**
 * Open the token-budget gate for an LLM turn: resolve (or open) the user's
 * session and check the budget. If a budget is fully spent, the response is sent
 * here (a canned message, no LLM call) and the caller stops. Otherwise it returns
 * a `budgetNote` to fold into the prompt (warn + summarize) when merely low.
 */
function openBudget(req: Request, res: Response, language: Lang): BudgetGate {
  const userId = userIdOf(req);
  const session = sessionsRepo.resolve(userId, { forceNew: forceNewSession(req), ttlMs: SESSION_TTL_MS });
  const budget = budgetOf(userId, session.tokens);
  if (budget.exhausted) {
    // Shaped so existing clients render it without special-casing: `reply` at the
    // top level, and an intent/result mirror so a message-style client shows it.
    const message = budgetHardStopText(budget, language);
    res.json({ blocked: true, intent: "chat", reply: message, result: { reply: message }, budget, state: stateOf(userId) });
    return { blocked: true };
  }
  return { blocked: false, userId, budgetNote: budgetDirective(budget) };
}

/** Charge the tokens spent this turn (session + day) and attach the fresh view. */
function settleBudget(userId: number, tokensSpent: number, payload: Record<string, unknown>) {
  sessionsRepo.add(userId, tokensSpent);
  usageRepo.add("day", dayKey(userId), tokensSpent);
  return { ...payload, budget: budgetOf(userId, sessionsRepo.peek(userId, SESSION_TTL_MS)) };
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
  const gate = openBudget(req, res, language);
  if (gate.blocked) return;
  const { userId, budgetNote } = gate;

  const glossary = glossaryRepo.list(userId);
  const pantry = pantryRepo.list(userId);
  const recipes = recipesRepo.list(userId);
  const equipment = equipmentRepo.list(userId);
  const preferences = preferencesRepo.list(userId);
  const exclusions: AdExclusions | undefined = req.body?.adExclusions;
  const seen: string[] | undefined = req.body?.adSeen;

  try {
    const { result: payload, tokens: spent } = await withUsage(async () => {
      // 1) extract a product list; glossary lets canonical names match the user's terms
      const items = await extractItems({ text, imageDataUrl, language, glossary });
      if (!items.length) {
        throw new HttpError(422, "Could not read any products. Try a clearer image or a text list.");
      }
      // 2) evaluate the basket (type, verdict, dish, buy-list); saved recipes let
      //    the model note "this looks like it's for your usual <recipe>"
      const analysis = await analyzeBasket(items, { language, glossary, pantry, recipes, equipment, preferences, budgetNote });

      // 3) persist — but only if this basket is the user's own consumption.
      //    If it's for guests / a gift / the pet / a one-off, we simply don't save
      //    it, so it never pollutes history, pantry, or cadence.
      const forSelf = !analysis.attribution || analysis.attribution === "self";
      if (forSelf) {
        purchasesRepo.add(
          userId,
          { source_type: imageDataUrl ? "image" : "text", basket_kind: analysis.basket_kind, raw_text: text },
          items
        );
        pantryRepo.observeFromPurchase(userId, items);
        persistLearned(userId, analysis);
      }

      // 4) MOCK ad, chosen after the answer, gated by user exclusions
      const sponsored = attachSponsored(
        {
          categories: items.map((i) => i.category),
          terms: tokens(analysis.dish, analysis.buy.join(" "), ...items.map((i) => i.name)),
        },
        exclusions,
        seen
      );

      return { items, analysis, sponsored, saved: forSelf, state: stateOf(userId) };
    });
    res.json(settleBudget(userId, spent, payload));
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
  const language = detectLanguage(question);
  const gate = openBudget(req, res, language);
  if (gate.blocked) return;
  const { userId, budgetNote } = gate;

  const exclusions: AdExclusions | undefined = req.body?.adExclusions;
  const seen: string[] | undefined = req.body?.adSeen;
  const glossary = glossaryRepo.list(userId);
  const pantry = pantryRepo.list(userId);
  const restock = itemStatsRepo.dueForRestock(userId);
  const recipes = recipesRepo.list(userId);
  const equipment = equipmentRepo.list(userId);
  const preferences = preferencesRepo.list(userId);
  const itemCats = (items ?? []).map((i) => i.category);
  const itemNames = (items ?? []).map((i) => i.name);

  try {
    const { result: payload, tokens: spent } = await withUsage(async () => {
      if (intent === "buy") {
        const result = await suggestBuy({ items, question, language, glossary, pantry, restock, budgetNote });
        const sponsored = attachSponsored(
          { categories: itemCats, terms: tokens(result.for_dish, result.buy.join(" "), ...itemNames) },
          exclusions,
          seen
        );
        return { intent, result, sponsored, state: stateOf(userId) };
      }
      const result = await suggestCook({ items, question, language, glossary, pantry, restock, recipes, equipment, preferences, budgetNote });
      const dishNames = result.dishes?.map((d) => d.name).join(" ");
      const sponsored = attachSponsored(
        { categories: itemCats, terms: tokens(dishNames, ...itemNames) },
        exclusions,
        seen
      );
      return { intent: "cook", result, sponsored, state: stateOf(userId) };
    });
    res.json(settleBudget(userId, spent, payload));
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

  const language = detectLanguage(message);
  const gate = openBudget(req, res, language);
  if (gate.blocked) return;
  const { userId, budgetNote } = gate;

  const exclusions: AdExclusions | undefined = req.body?.adExclusions;
  const seen: string[] | undefined = req.body?.adSeen;
  const glossary = glossaryRepo.list(userId);
  const pantry = pantryRepo.list(userId);
  const restock = itemStatsRepo.dueForRestock(userId);
  const recipes = recipesRepo.list(userId);
  const equipment = equipmentRepo.list(userId);
  const preferences = preferencesRepo.list(userId);

  try {
    const { result: payload, tokens: spent } = await withUsage(async () => {
      const result = await converse({ items, history, message, language, glossary, pantry, restock, recipes, equipment, preferences, budgetNote });
      persistLearned(userId, result);
      // The model recognizes a recipe on its own (no button) and dedupes against
      // saved ones; persist it when present. recipesRepo.save upserts by name.
      if (result.recipe_learned?.name?.trim()) {
        recipesRepo.save(userId, result.recipe_learned, message);
        // Equipment named in a saved recipe is evidence the user has it.
        equipmentRepo.observeFromRecipe(userId, result.recipe_learned.equipment ?? []);
      }
      // The user revealed the last basket wasn't theirs -> drop it from history and
      // roll back the pantry it observed.
      if (result.forget_last_purchase) {
        const names = purchasesRepo.deleteLast(userId);
        pantryRepo.removeObserved(userId, names);
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
      return { result, sponsored, state: stateOf(userId) };
    });
    res.json(settleBudget(userId, spent, payload));
  } catch (err) {
    fail(res, err);
  }
}

/**
 * POST /api/message — one entry point for free text. The service asks the LLM to
 * classify the message (basket | cook | buy | chat) and dispatches internally to
 * the matching primitive, returning a unified response shaped like the endpoint
 * that would have handled it, plus an `intent` field. This keeps the bot thin:
 * it forwards text and renders by `intent`, with no keyword routing of its own.
 */
export async function messageFlow(req: Request, res: Response): Promise<void> {
  if (!ensureConfigured(res)) return;

  const text: string | undefined = req.body?.text;
  const items: Item[] | undefined = Array.isArray(req.body?.items) ? req.body.items : undefined;
  const history: Turn[] | undefined = Array.isArray(req.body?.history) ? req.body.history : undefined;

  if (!text?.trim()) {
    res.status(400).json({ error: "Provide a message." });
    return;
  }

  const language = detectLanguage(text);
  const gate = openBudget(req, res, language);
  if (gate.blocked) return;
  const { userId, budgetNote } = gate;

  const glossary = glossaryRepo.list(userId);
  const pantry = pantryRepo.list(userId);
  const restock = itemStatsRepo.dueForRestock(userId);
  const recipes = recipesRepo.list(userId);
  const equipment = equipmentRepo.list(userId);
  const preferences = preferencesRepo.list(userId);
  const exclusions: AdExclusions | undefined = req.body?.adExclusions;
  const seen: string[] | undefined = req.body?.adSeen;
  const itemCats = (items ?? []).map((i) => i.category);
  const itemNames = (items ?? []).map((i) => i.name);

  try {
    const { result: payload, tokens: spent } = await withUsage(async () => {
      const intent = await classifyMessage({ text, hasBasket: Boolean(items?.length), language });

      if (intent === "basket") {
        // Same pipeline as /api/analyze, but for a pasted text list.
        const parsed = await extractItems({ text, language, glossary });
        if (!parsed.length) {
          throw new HttpError(422, "Could not read any products. Try a clearer list.");
        }
        const analysis = await analyzeBasket(parsed, { language, glossary, pantry, recipes, equipment, preferences, budgetNote });
        const forSelf = !analysis.attribution || analysis.attribution === "self";
        if (forSelf) {
          purchasesRepo.add(userId, { source_type: "text", basket_kind: analysis.basket_kind, raw_text: text }, parsed);
          pantryRepo.observeFromPurchase(userId, parsed);
          persistLearned(userId, analysis);
        }
        const sponsored = attachSponsored(
          { categories: parsed.map((i) => i.category), terms: tokens(analysis.dish, analysis.buy.join(" "), ...parsed.map((i) => i.name)) },
          exclusions,
          seen
        );
        return { intent: "basket", items: parsed, analysis, sponsored, saved: forSelf, state: stateOf(userId) };
      }

      if (intent === "buy") {
        const result = await suggestBuy({ items, question: text, language, glossary, pantry, restock, budgetNote });
        const sponsored = attachSponsored(
          { categories: itemCats, terms: tokens(result.for_dish, result.buy.join(" "), ...itemNames) },
          exclusions,
          seen
        );
        return { intent: "buy", result, sponsored, state: stateOf(userId) };
      }

      if (intent === "cook") {
        const result = await suggestCook({ items, question: text, language, glossary, pantry, restock, recipes, equipment, preferences, budgetNote });
        const sponsored = attachSponsored(
          { categories: itemCats, terms: tokens(result.dishes?.map((d) => d.name).join(" "), ...itemNames) },
          exclusions,
          seen
        );
        return { intent: "cook", result, sponsored, state: stateOf(userId) };
      }

      // chat — a follow-up/correction; converse needs the current basket (may be empty)
      const result = await converse({ items: items ?? [], history, message: text, language, glossary, pantry, restock, recipes, equipment, preferences, budgetNote });
      persistLearned(userId, result);
      if (result.recipe_learned?.name?.trim()) {
        recipesRepo.save(userId, result.recipe_learned, text);
        equipmentRepo.observeFromRecipe(userId, result.recipe_learned.equipment ?? []);
      }
      if (result.forget_last_purchase) {
        const names = purchasesRepo.deleteLast(userId);
        pantryRepo.removeObserved(userId, names);
      }
      const sponsored = attachSponsored(
        { categories: itemCats, terms: tokens(result.dishes?.map((d) => d.name).join(" ") ?? "", (result.buy ?? []).join(" "), ...itemNames) },
        exclusions,
        seen
      );
      return { intent: "chat", result, sponsored, state: stateOf(userId) };
    });
    res.json(settleBudget(userId, spent, payload));
  } catch (err) {
    fail(res, err);
  }
}

/** GET /api/state — the durable memory (pantry + glossary) the client renders. */
export function stateFlow(req: Request, res: Response): void {
  res.json(stateOf(userIdOf(req)));
}

/**
 * GET /api/usage — the user's token "balance" (session + daily budgets, with
 * remaining) plus light durable-memory stats. Read-only; no LLM call, so it is
 * free and always available even once a budget is spent.
 */
export function usageFlow(req: Request, res: Response): void {
  const userId = userIdOf(req);
  // Read-only: peek the active session without opening or extending one.
  const view = budgetOf(userId, sessionsRepo.peek(userId, SESSION_TTL_MS));
  // remaining is null when a budget is disabled (limit 0 = unlimited).
  const remaining = (b: { used: number; limit: number }) => (b.limit > 0 ? Math.max(0, b.limit - b.used) : null);
  const s = stateOf(userId);
  res.json({
    budget: {
      session: { ...view.session, remaining: remaining(view.session) },
      day: { ...view.day, remaining: remaining(view.day) },
      low: view.low,
      exhausted: view.exhausted,
      warnRatio: WARN_RATIO,
    },
    stats: {
      purchases: purchasesRepo.count(userId),
      pantry: s.pantry.length,
      glossary: s.glossary.length,
      recipes: s.recipes.length,
      equipment: s.equipment.length,
      preferences: s.preferences.length,
      restockDue: s.restock.length,
    },
  });
}

/**
 * POST /api/session — explicit session control from the bot. `{ action: "open" }`
 * starts a fresh session (resetting the session token budget); `{ action:"close" }`
 * ends the current one. Both are optional conveniences: a session also opens on
 * the first message and self-closes on exhaustion or after the inactivity TTL.
 * Returns the fresh budget view.
 */
export function sessionFlow(req: Request, res: Response): void {
  const userId = userIdOf(req);
  const action = String(req.body?.action ?? "open").toLowerCase();
  if (action === "close") {
    sessionsRepo.close(userId);
  } else {
    sessionsRepo.resolve(userId, { forceNew: true, ttlMs: SESSION_TTL_MS });
  }
  res.json({ action: action === "close" ? "close" : "open", budget: budgetOf(userId, sessionsRepo.peek(userId, SESSION_TTL_MS)) });
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
  const preferenceRemove: string | undefined = req.body?.preferenceRemove;
  if (preferenceRemove) preferencesRepo.remove(userId, preferenceRemove);
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
  // A flow-raised HttpError carries its own status (e.g. 422 no products read).
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
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
