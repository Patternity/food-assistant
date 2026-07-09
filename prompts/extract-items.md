Extract the grocery items from the input, which is either a basket screenshot,
a receipt photo, or a plain text list.

Rules:
- List each distinct product once.
- Normalize obvious abbreviations to a plain product name (receipts often use
  short codes). If unsure, keep your best readable guess.
- Include quantity and unit only if clearly present; otherwise leave them null.
- Guess a coarse category from this set: meat, fish, vegetable, fruit, dairy,
  grain, bread, drink, water, sweet, snack, household, condiment, other.
- Do not invent items that are not present. Do not add "missing" items here.

Return ONLY JSON in this exact shape:
{
  "items": [
    { "name": "string", "qty": number|null, "unit": "string|null", "category": "string" }
  ]
}
