// Minimal, deterministic language handling for user-facing output.
//
// The assistant must reply in the user's language, but the JSON keys and the
// enum values (basket_kind, category) must stay English because the code and
// the ad/eval layers match on them. We detect the input language here and pass
// an explicit target to the prompts, rather than letting the model guess from a
// one-word message like "Оцени".

export type Lang = "ru" | "en";

const DEFAULT_LANG: Lang = (process.env.LLM_DEFAULT_LANGUAGE as Lang) || "ru";

/** Detect language from free text. Cyrillic => ru, else en; empty => default. */
export function detectLanguage(text?: string): Lang {
  if (!text || !text.trim()) return DEFAULT_LANG;
  const cyrillic = (text.match(/[Ѐ-ӿ]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (cyrillic === 0 && latin === 0) return DEFAULT_LANG;
  return cyrillic >= latin ? "ru" : "en";
}

export function languageName(lang: Lang): string {
  return lang === "ru" ? "Russian" : "English";
}

/**
 * Instruction appended to every task prompt: localize human-readable text, but
 * keep JSON keys and the basket_kind/category enums in English.
 */
export function languageDirective(lang: Lang): string {
  return [
    "",
    "",
    `LANGUAGE: Write every human-readable string value (verdict, dish, reply,`,
    `items in buy / likely_at_home, questions, and product names) in`,
    `${languageName(lang)}.`,
    `Do NOT translate the JSON keys. Keep these machine values ALWAYS in English,`,
    `exactly from the allowed sets, in EVERY object where they appear:`,
    `- "basket_kind": topup|full|snack|household|recipe|unclear`,
    `- any "category" field (on items, glossary_learned, pantry_learned):`,
    `  meat|fish|vegetable|fruit|dairy|grain|bread|drink|water|sweet|snack|`,
    `  household|condiment|other`,
    `- any "state" field (pantry_learned): available|missing`,
    `Only the free-text values ("name", "canonical", and the human-readable`,
    `strings above) are localized; the machine values are never translated.`,
  ].join("\n");
}
