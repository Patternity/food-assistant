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

// Controllers own the use-case flow: validate input, load prerequisites,
// sequence domain primitives, and map failures to user-facing errors. Services
// stay as composable primitives (see assistantService.ts).

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
  const glossary: GlossaryEntry[] | undefined = req.body?.glossary;
  const pantry: PantryItem[] | undefined = req.body?.pantry;

  try {
    // 1) extract a product list from the image and/or text
    const items = await extractItems({ text, imageDataUrl, language });
    if (!items.length) {
      res.status(422).json({ error: "Could not read any products. Try a clearer image or a text list." });
      return;
    }
    // 2) evaluate the basket (type, verdict, dish, buy-list)
    const analysis = await analyzeBasket(items, { language, glossary, pantry });

    // 3) MOCK ad, chosen after the answer, gated by user exclusions
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

    res.json({ items, analysis, sponsored });
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
  const glossary: GlossaryEntry[] | undefined = req.body?.glossary;
  const pantry: PantryItem[] | undefined = req.body?.pantry;
  const itemCats = (items ?? []).map((i) => i.category);
  const itemNames = (items ?? []).map((i) => i.name);
  const language = detectLanguage(question);

  try {
    if (intent === "buy") {
      const result = await suggestBuy({ items, question, language, glossary, pantry });
      const sponsored = attachSponsored(
        { categories: itemCats, terms: tokens(result.for_dish, result.buy.join(" "), ...itemNames) },
        exclusions,
        seen
      );
      res.json({ intent, result, sponsored });
    } else {
      const result = await suggestCook({ items, question, language, glossary, pantry });
      const dishNames = result.dishes?.map((d) => d.name).join(" ");
      const sponsored = attachSponsored(
        { categories: itemCats, terms: tokens(dishNames, ...itemNames) },
        exclusions,
        seen
      );
      res.json({ intent: "cook", result, sponsored });
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
  const glossary: GlossaryEntry[] | undefined = req.body?.glossary;
  const pantry: PantryItem[] | undefined = req.body?.pantry;
  const language = detectLanguage(message);

  try {
    const result = await converse({ items, history, message, language, glossary, pantry });
    const dishNames = result.dishes?.map((d) => d.name).join(" ") ?? "";
    const sponsored = attachSponsored(
      {
        categories: items.map((i) => i.category),
        terms: tokens(dishNames, (result.buy ?? []).join(" "), ...items.map((i) => i.name)),
      },
      exclusions,
      seen
    );
    res.json({ result, sponsored });
  } catch (err) {
    fail(res, err);
  }
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
