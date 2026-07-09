import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// MOCK advertising layer (alpha, product-testing only). No real ad network, no
// network calls, no data leaves the process. It exists to test the UX of a
// sponsored block and, importantly, the trust firewall and exclusion rules.
//
// TRUST FIREWALL: this module runs AFTER the assistant's neutral answer is
// produced, on a separate input. It cannot influence the advice. It only picks
// at most one offer from an approved catalog and filters it by policy.
//
// This is the deterministic policy-engine skeleton described in the monetization
// analysis: context fit -> hard exclusions -> safety -> rank. It reuses the same
// exclusion inputs the assistant uses (categories/brands/retailers the user
// asked not to see), so "do not suggest X" gates ads too.

export type Offer = {
  offer_id: string;
  retailer: string;
  brand: string;
  product_name: string;
  category: string;
  goal_tags: string[];
  claim: string;
  label: string;
};

export type AdExclusions = {
  categories?: string[];
  brands?: string[];
  retailers?: string[];
};

export type AdContext = {
  categories: string[]; // product categories present in the answer
  terms: string[]; // free tokens from dish name / buy list / item names
  exclusions?: AdExclusions;
  seenOfferIds?: string[]; // offers already shown this session (avoid repeats)
};

// Categories that are never advertised, regardless of user profile (safety gate).
const PROHIBITED_ALWAYS = new Set(["alcohol", "tobacco"]);

const offersPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "mock-offers.json");
let catalog: Offer[] | null = null;

function loadCatalog(): Offer[] {
  if (!catalog) catalog = JSON.parse(readFileSync(offersPath, "utf8")) as Offer[];
  return catalog;
}

function norm(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Return at most one eligible sponsored offer for the given answer context, or
 * null. Deterministic; no LLM.
 */
export function matchOffer(ctx: AdContext): Offer | null {
  const cats = new Set(ctx.categories.map(norm));
  const terms = ctx.terms.map(norm);
  const exCats = new Set((ctx.exclusions?.categories ?? []).map(norm));
  const exBrands = new Set((ctx.exclusions?.brands ?? []).map(norm));
  const exRetailers = new Set((ctx.exclusions?.retailers ?? []).map(norm));
  const seen = new Set(ctx.seenOfferIds ?? []);

  let best: { offer: Offer; score: number } | null = null;

  for (const offer of loadCatalog()) {
    const cat = norm(offer.category);

    // Do not repeat an offer already shown this session.
    if (seen.has(offer.offer_id)) continue;

    // 4. SAFETY: always-prohibited categories are never shown.
    if (PROHIBITED_ALWAYS.has(cat)) continue;

    // 2. HARD EXCLUSIONS: user said no to this category / brand / retailer.
    if (exCats.has(cat)) continue;
    if (exBrands.has(norm(offer.brand))) continue;
    if (exRetailers.has(norm(offer.retailer))) continue;

    // 1. CONTEXT FIT: offer must relate to what the answer is actually about.
    let score = 0;
    if (cats.has(cat)) score += 2;
    const productTokens = norm(offer.product_name).split(/\s+/);
    if (productTokens.some((t) => t.length > 2 && terms.some((term) => term.includes(t) || t.includes(term)))) {
      score += 3;
    }
    if (score === 0) continue;

    // 6. RANK: keep the best-fitting offer. Sponsorship is only a tie-breaker,
    // never a boost over a better-fitting offer for the user.
    if (!best || score > best.score) best = { offer, score };
  }

  return best?.offer ?? null;
}
