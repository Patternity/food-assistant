Extract the grocery items from the input, which is either a basket screenshot,
a receipt photo, or a plain text list.

Rules:
- List each distinct product once.
- "name": the product as read (normalize obvious abbreviations/short codes to a
  readable form, but keep it close to what was on the receipt/list).
- "canonical": a short, generic product name that identifies WHAT the product is,
  with brand, package size, quantity, weight and marketing words removed — the
  name a person would use for the same product regardless of brand or pack. Use
  the user's language. If the user glossary maps this product to a term, use that
  exact term as the canonical. Two different labels for the same product must get
  the SAME canonical (this is what lets purchases and pantry line up over time).
- Include quantity and unit only if clearly present; otherwise leave them null.
- Guess a coarse category from this set: meat, fish, vegetable, fruit, dairy,
  grain, bread, drink, water, sweet, snack, household, condiment, other.
- Do not invent items that are not present. Do not add "missing" items here.

Return ONLY JSON in this exact shape:
{
  "items": [
    { "name": "string", "canonical": "string", "qty": number|null, "unit": "string|null", "category": "string" }
  ]
}
